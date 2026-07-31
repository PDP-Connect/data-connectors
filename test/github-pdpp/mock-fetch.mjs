const user = { id: 1, login: "octocat", name: "Octocat", created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z" };
const repository = { id: 2, name: "hello", full_name: "octocat/hello", private: false, fork: false, archived: false, disabled: false, owner: { login: "octocat" }, created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z", pushed_at: "2020-01-01T00:00:00Z" };
globalThis.fetch = async (url, options) => {
  if (options?.headers?.Authorization !== "Bearer github-pdpp-test-secret") {
    throw new Error("mock transport did not receive the expected authorization header");
  }
  const path = new URL(url).pathname;
  const body = path === "/user" ? user : path === "/user/repos" ? [repository] : [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
