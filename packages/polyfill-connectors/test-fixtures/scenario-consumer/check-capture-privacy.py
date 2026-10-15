#!/usr/bin/env python3
"""Fail-closed checks for credentials and private browser state in JSON captures."""

import json
import base64
import binascii
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

SENSITIVE_KEY = re.compile(
    r"cookie|authorization|proxy.?authorization|access.?token|refresh.?token|"
    r"session.?token|api.?key|credential|password|passwd|client.?secret|private.?key",
    re.IGNORECASE,
)
SENSITIVE_HEADER = re.compile(
    r"cookie|authorization|proxy.?authorization|x-.*auth|x-.*token|api.?key",
    re.IGNORECASE,
)
SENSITIVE_TEXT = (
    ("bearer", re.compile(r"\bbearer\s+[A-Za-z0-9._~+/-]{8,}", re.IGNORECASE)),
    (
        "jwt",
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    ),
    (
        "named-token",
        re.compile(r"\b(access|refresh|session|auth)[_-]?token\b\s*[:=]", re.IGNORECASE),
    ),
    (
        "credential-assignment",
        re.compile(r"\b(password|passwd|client[_-]?secret|api[_-]?key)\b\s*[:=]", re.IGNORECASE),
    ),
    (
        "private-profile-path",
        re.compile(r"/(?:home|Users)/[^/]+/(?:\.tmp|\.config|\.cache|\.local)/[^\s\"']*", re.IGNORECASE),
    ),
)

Finding = tuple[str, str, str]


def inspect_string(value: str, path: str, filename: str, findings: list[Finding]) -> None:
    for category, pattern in SENSITIVE_TEXT:
        if pattern.search(value):
            findings.append((filename, category, path))

    if "http://" not in value.lower() and "https://" not in value.lower():
        return
    try:
        url = urlsplit(value)
    except ValueError:
        findings.append((filename, "malformed-url", path))
        return

    if url.username is not None or url.password is not None:
        findings.append((filename, "url-userinfo", path))
    for key, token in parse_qsl(url.query, keep_blank_values=True):
        if SENSITIVE_KEY.search(key):
            findings.append((filename, "sensitive-query-key", f"{path}.query.{key}"))
        elif len(token) >= 20 and re.fullmatch(r"[A-Za-z0-9._~+/-]+", token):
            findings.append((filename, "potential-query-token", f"{path}.query.{key}"))


def inspect_body_text(
    text: str,
    path: str,
    filename: str,
    findings: list[Finding],
    mime_type: str,
) -> None:
    stripped = text.lstrip()
    json_declared = "json" in mime_type.lower()
    json_shaped = stripped.startswith(("{", "["))
    if not (json_declared or json_shaped):
        inspect_string(text, path, filename, findings)
        return
    try:
        embedded = json.loads(text)
    except json.JSONDecodeError:
        findings.append((filename, "malformed-embedded-json", path))
        return
    walk(embedded, f"{path}.<json>", filename, findings)


def walk(value: object, path: str, filename: str, findings: list[Finding]) -> None:
    if isinstance(value, dict):
        encoding = value.get("encoding")
        if isinstance(encoding, str) and encoding.lower() == "base64":
            encoded = value.get("text")
            if not isinstance(encoded, str):
                findings.append((filename, "invalid-declared-base64", f"{path}.text"))
            else:
                try:
                    decoded_bytes = base64.b64decode(encoded, validate=True)
                except (binascii.Error, ValueError):
                    findings.append((filename, "invalid-declared-base64", f"{path}.text"))
                else:
                    try:
                        decoded_text = decoded_bytes.decode("utf-8")
                    except UnicodeDecodeError:
                        findings.append((filename, "undecodable-declared-base64", f"{path}.text"))
                    else:
                        inspect_body_text(
                            decoded_text,
                            f"{path}.text.<base64>",
                            filename,
                            findings,
                            str(value.get("mimeType", "")),
                        )
            for key, child_value in value.items():
                if key not in ("encoding", "text"):
                    child_path = f"{path}.{key}" if path else str(key)
                    walk(child_value, child_path, filename, findings)
            return

        for key, child_value in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if SENSITIVE_KEY.search(str(key)) and child_value not in (None, "", [], {}):
                findings.append((filename, "sensitive-field-name", child_path))
            if (
                path.lower().endswith("headers")
                and SENSITIVE_HEADER.search(str(key))
            ) or (
                re.search(r"\.headers\[\d+\]$", path, re.IGNORECASE)
                and key.lower() == "name"
                and isinstance(child_value, str)
                and SENSITIVE_HEADER.search(child_value)
            ):
                findings.append((filename, "sensitive-header-name", child_path))
            if (
                "localstorage" in path.lower()
                and key.lower() == "name"
                and isinstance(child_value, str)
                and SENSITIVE_KEY.search(child_value)
            ):
                findings.append((filename, "sensitive-storage-key", child_path))
            if (
                re.search(r"\.params\[\d+\]$", path, re.IGNORECASE)
                and key.lower() == "name"
                and isinstance(child_value, str)
                and SENSITIVE_KEY.search(child_value)
                and value.get("value") not in (None, "", [], {})
            ):
                findings.append((filename, "sensitive-parameter-name", child_path))
            if (
                key == "text"
                and path.lower().endswith((".content", ".postdata"))
                and isinstance(child_value, str)
            ):
                inspect_body_text(
                    child_value,
                    child_path,
                    filename,
                    findings,
                    str(value.get("mimeType", "")),
                )
            else:
                walk(child_value, child_path, filename, findings)
    elif isinstance(value, list):
        for index, child_value in enumerate(value):
            walk(child_value, f"{path}[{index}]", filename, findings)
    elif isinstance(value, str):
        inspect_string(value, path, filename, findings)


def scan(paths: list[Path]) -> list[Finding]:
    findings: list[Finding] = []
    for path in paths:
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            findings.append((path.name, "invalid-json-or-unreadable", "$"))
            continue
        walk(document, "$", path.name, findings)
    return findings


def self_test() -> int:
    fake = "fake-secret-value-1234567890"
    negative_cases = [
        ("har-request-authorization", {"log": {"entries": [{"request": {"headers": [{"name": "Authorization", "value": fake}]}}]}}, "sensitive-header-name"),
        ("har-request-cookie", {"log": {"entries": [{"request": {"headers": [{"name": "Cookie", "value": fake}]}}]}}, "sensitive-header-name"),
        ("har-request-set-cookie", {"log": {"entries": [{"request": {"headers": [{"name": "Set-Cookie", "value": fake}]}}]}}, "sensitive-header-name"),
        ("har-response-authorization", {"log": {"entries": [{"response": {"headers": [{"name": "Authorization", "value": fake}]}}]}}, "sensitive-header-name"),
        ("har-response-cookie", {"log": {"entries": [{"response": {"headers": [{"name": "Cookie", "value": fake}]}}]}}, "sensitive-header-name"),
        ("har-response-set-cookie", {"log": {"entries": [{"response": {"headers": [{"name": "Set-Cookie", "value": fake}]}}]}}, "sensitive-header-name"),
        ("embedded-json-body", {"log": {"entries": [{"response": {"content": {"mimeType": "application/json", "text": json.dumps({"access_token": fake})}}}]}}, "sensitive-field-name"),
        ("base64-json-body", {"log": {"entries": [{"response": {"content": {"mimeType": "application/json", "encoding": "base64", "text": base64.b64encode(json.dumps({"Authorization": fake}).encode()).decode()}}}]}}, "sensitive-field-name"),
        ("request-postdata-json", {"log": {"entries": [{"request": {"postData": {"mimeType": "application/json", "text": json.dumps({"access_token": fake})}}}]}}, "sensitive-field-name"),
        ("request-postdata-base64", {"log": {"entries": [{"request": {"postData": {"mimeType": "application/json", "encoding": "base64", "text": base64.b64encode(json.dumps({"client_secret": fake}).encode()).decode()}}}]}}, "sensitive-field-name"),
        ("request-postdata-malformed-base64", {"log": {"entries": [{"request": {"postData": {"encoding": "base64", "text": "%%%"}}}]}}, "invalid-declared-base64"),
        ("request-postdata-undecodable-base64", {"log": {"entries": [{"request": {"postData": {"encoding": "base64", "text": base64.b64encode(b"\xff\xfe").decode()}}}]}}, "undecodable-declared-base64"),
        ("request-postdata-param", {"log": {"entries": [{"request": {"postData": {"params": [{"name": "access_token", "value": fake}]}}}]}}, "sensitive-parameter-name"),
        ("storage-origin", {"origins": [{"origin": "https://fixture.invalid", "localStorage": [{"name": "access_token", "value": fake}]}]}, "sensitive-storage-key"),
        ("malformed-declared-base64", {"log": {"entries": [{"response": {"content": {"encoding": "base64", "text": "%%%"}}}]}}, "invalid-declared-base64"),
        ("undecodable-declared-base64", {"log": {"entries": [{"response": {"content": {"encoding": "base64", "text": base64.b64encode(b"\xff\xfe").decode()}}}]}}, "undecodable-declared-base64"),
        ("scenario-header-map", {"headers": {"Authorization": fake}}, "sensitive-header-name"),
        ("storage-cookie-array", {"cookies": [{"name": "session", "value": fake}]}, "sensitive-field-name"),
        ("sensitive-query", {"url": f"https://fixture.invalid/path?access_token={fake}"}, "sensitive-query-key"),
        ("private-profile-path", {"path": "/home/example/.tmp/chrome-profile-123/Default"}, "private-profile-path"),
    ]
    with tempfile.TemporaryDirectory(prefix="scenario-privacy-negative-", dir=Path(__file__).parent) as directory:
        missing = []
        for name, document, required_category in negative_cases:
            path = Path(directory) / f"{name}.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            findings = scan([path])
            if required_category not in {category for _, category, _ in findings}:
                missing.append(name)
    if missing:
        print(f"SELF_TEST FAIL controls_not_rejected={','.join(missing)}")
        return 1
    print(f"SELF_TEST PASS negative_artifacts_rejected={len(negative_cases)} categories_only=yes")
    return 0


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    if len(sys.argv) < 2 or "--" in sys.argv[1:]:
        print("usage: check-capture-privacy.py <scenario-or-har-or-storage-json>...")
        return 2
    findings = scan([Path(argument) for argument in sys.argv[1:]])
    if findings:
        for filename, category, field_path in findings:
            print(f"FAIL file={filename} category={category} field={field_path}")
        return 1
    print(
        f"PASS files={len(sys.argv) - 1} findings=0 "
        "checked=fields,headers,URLs,query-values,captured-content,profile-paths"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
