# Frozen scope shapes

Generated from [legacy-shapes.json](legacy-shapes.json) and its schema files. Do not edit; run `npm run legacy-shapes:generate`.

Paths start at each document's payload (`schema`), not its metadata. `[]` marks an array element, including at the payload root; `.*` marks a dynamic object key with a declared value schema. Local `$defs` references are expanded at their use sites.

Types list declared alternatives. Paths can be optional or belong to only one alternative. `unspecified` means no type is declared. Other properties may be allowed; these tables list declarations, not every possible field. The linked schemas define requiredness and validation.

| Scope ID | Schema | Declared paths |
| --- | --- | ---: |
| [amazon.orders](#amazon-orders) | [schema](connectors/amazon/schemas/amazon.orders.json) | 12 |
| [amazon.profile](#amazon-profile) | [schema](connectors/amazon/schemas/amazon.profile.json) | 2 |
| [chatgpt.conversations](#chatgpt-conversations) | [schema](connectors/openai/schemas/chatgpt.conversations.json) | 16 |
| [chatgpt.memories](#chatgpt-memories) | [schema](connectors/openai/schemas/chatgpt.memories.json) | 8 |
| [claude.conversations](#claude-conversations) | [schema](connectors/anthropic/schemas/claude.conversations.json) | 30 |
| [claude.projects](#claude-projects) | [schema](connectors/anthropic/schemas/claude.projects.json) | 18 |
| [claude_code.prompts](#claude_code-prompts) | [schema](connectors/anthropic/schemas/claude_code.prompts.json) | 16 |
| [claude_code.sessions](#claude_code-sessions) | [schema](connectors/anthropic/schemas/claude_code.sessions.json) | 25 |
| [claude_code.trajectories](#claude_code-trajectories) | [schema](connectors/anthropic/schemas/claude_code.trajectories.json) | 56 |
| [claude_code.usage](#claude_code-usage) | [schema](connectors/anthropic/schemas/claude_code.usage.json) | 43 |
| [doordash.orders](#doordash-orders) | [schema](connectors/doordash/schemas/doordash.orders.json) | 14 |
| [github.contributions](#github-contributions) | [schema](connectors/github/schemas/github.contributions.json) | 18 |
| [github.events](#github-events) | [schema](connectors/github/schemas/github.events.json) | 16 |
| [github.history](#github-history) | [schema](connectors/github/schemas/github.history.json) | 42 |
| [github.profile](#github-profile) | [schema](connectors/github/schemas/github.profile.json) | 29 |
| [github.repositories](#github-repositories) | [schema](connectors/github/schemas/github.repositories.json) | 12 |
| [github.starred](#github-starred) | [schema](connectors/github/schemas/github.starred.json) | 8 |
| [heb.nutrition](#heb-nutrition) | [schema](connectors/heb/schemas/heb.nutrition.json) | 37 |
| [heb.orders](#heb-orders) | [schema](connectors/heb/schemas/heb.orders.json) | 19 |
| [heb.profile](#heb-profile) | [schema](connectors/heb/schemas/heb.profile.json) | 8 |
| [icloud_notes.folders](#icloud_notes-folders) | [schema](connectors/apple/schemas/icloud_notes.folders.json) | 5 |
| [icloud_notes.notes](#icloud_notes-notes) | [schema](connectors/apple/schemas/icloud_notes.notes.json) | 13 |
| [instagram.ads](#instagram-ads) | [schema](connectors/meta/schemas/instagram.ads.json) | 10 |
| [instagram.following](#instagram-following) | [schema](connectors/meta/schemas/instagram.following.json) | 9 |
| [instagram.posts](#instagram-posts) | [schema](connectors/meta/schemas/instagram.posts.json) | 12 |
| [instagram.profile](#instagram-profile) | [schema](connectors/meta/schemas/instagram.profile.json) | 11 |
| [linkedin.connections](#linkedin-connections) | [schema](connectors/linkedin/schemas/linkedin.connections.json) | 6 |
| [linkedin.education](#linkedin-education) | [schema](connectors/linkedin/schemas/linkedin.education.json) | 7 |
| [linkedin.experience](#linkedin-experience) | [schema](connectors/linkedin/schemas/linkedin.experience.json) | 7 |
| [linkedin.languages](#linkedin-languages) | [schema](connectors/linkedin/schemas/linkedin.languages.json) | 4 |
| [linkedin.profile](#linkedin-profile) | [schema](connectors/linkedin/schemas/linkedin.profile.json) | 7 |
| [linkedin.skills](#linkedin-skills) | [schema](connectors/linkedin/schemas/linkedin.skills.json) | 4 |
| [oura.activity](#oura-activity) | [schema](connectors/oura/schemas/oura.activity.json) | 23 |
| [oura.readiness](#oura-readiness) | [schema](connectors/oura/schemas/oura.readiness.json) | 17 |
| [oura.sleep](#oura-sleep) | [schema](connectors/oura/schemas/oura.sleep.json) | 34 |
| [shop.orders](#shop-orders) | [schema](connectors/shopify/schemas/shop.orders.json) | 13 |
| [spotify.playlists](#spotify-playlists) | [schema](connectors/spotify/schemas/spotify.playlists.json) | 22 |
| [spotify.profile](#spotify-profile) | [schema](connectors/spotify/schemas/spotify.profile.json) | 7 |
| [spotify.savedTracks](#spotify-savedtracks) | [schema](connectors/spotify/schemas/spotify.savedTracks.json) | 16 |
| [steam.friends](#steam-friends) | [schema](connectors/valve/schemas/steam.friends.json) | 7 |
| [steam.games](#steam-games) | [schema](connectors/valve/schemas/steam.games.json) | 15 |
| [steam.profile](#steam-profile) | [schema](connectors/valve/schemas/steam.profile.json) | 13 |
| [uber.receipts](#uber-receipts) | [schema](connectors/uber/schemas/uber.receipts.json) | 12 |
| [uber.trips](#uber-trips) | [schema](connectors/uber/schemas/uber.trips.json) | 13 |
| [wholefoods.nutrition](#wholefoods-nutrition) | [schema](connectors/wholefoods/schemas/wholefoods.nutrition.json) | 19 |
| [wholefoods.orders](#wholefoods-orders) | [schema](connectors/wholefoods/schemas/wholefoods.orders.json) | 18 |
| [wholefoods.profile](#wholefoods-profile) | [schema](connectors/wholefoods/schemas/wholefoods.profile.json) | 2 |
| [youtube.history](#youtube-history) | [schema](connectors/google/schemas/youtube.history.json) | 11 |
| [youtube.likes](#youtube-likes) | [schema](connectors/google/schemas/youtube.likes.json) | 9 |
| [youtube.playlistItems](#youtube-playlistitems) | [schema](connectors/google/schemas/youtube.playlistItems.json) | 14 |
| [youtube.playlists](#youtube-playlists) | [schema](connectors/google/schemas/youtube.playlists.json) | 10 |
| [youtube.profile](#youtube-profile) | [schema](connectors/google/schemas/youtube.profile.json) | 12 |
| [youtube.subscriptions](#youtube-subscriptions) | [schema](connectors/google/schemas/youtube.subscriptions.json) | 12 |
| [youtube.watchLater](#youtube-watchlater) | [schema](connectors/google/schemas/youtube.watchLater.json) | 9 |

<a id="amazon-orders"></a>
## amazon.orders

<details>
<summary>12 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `orders` | `array` |
| `orders[]` | `object` |
| `orders[].deliveryStatus` | `string` |
| `orders[].items` | `array` |
| `orders[].items[]` | `object` |
| `orders[].items[].name` | `string` |
| `orders[].items[].price` | `string` |
| `orders[].items[].url` | `string` |
| `orders[].orderDate` | `string` |
| `orders[].orderId` | `string` |
| `orders[].orderTotal` | `string` |
| `total` | `number` |

</details>

<a id="amazon-profile"></a>
## amazon.profile

<details>
<summary>2 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `isPrime` | `boolean` |
| `name` | `string` |

</details>

<a id="chatgpt-conversations"></a>
## chatgpt.conversations

<details>
<summary>16 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `conversations` | `array` |
| `conversations[]` | `object` |
| `conversations[].create_time` | `string` |
| `conversations[].id` | `string` |
| `conversations[].message_count` | `number` |
| `conversations[].messages` | `array` |
| `conversations[].messages[]` | `object` |
| `conversations[].messages[].content` | `string` |
| `conversations[].messages[].content_type` | `string` |
| `conversations[].messages[].create_time` | `null` / `string` |
| `conversations[].messages[].id` | `string` |
| `conversations[].messages[].model` | `null` / `string` |
| `conversations[].messages[].role` | `string` |
| `conversations[].title` | `string` |
| `conversations[].update_time` | `string` |
| `total` | `number` |

</details>

<a id="chatgpt-memories"></a>
## chatgpt.memories

<details>
<summary>8 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `memories` | `array` |
| `memories[]` | `object` |
| `memories[].content` | `string` |
| `memories[].created_at` | `string` |
| `memories[].id` | `string` |
| `memories[].type` | `string` |
| `memories[].updated_at` | `string` |
| `total` | `number` |

</details>

<a id="claude-conversations"></a>
## claude.conversations

<details>
<summary>30 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `apiError` | `null` / `string` |
| `conversations` | `array` |
| `conversations[]` | `object` |
| `conversations[].createdAt` | `null` / `string` |
| `conversations[].fetchError` | `null` / `string` |
| `conversations[].href` | `string` |
| `conversations[].id` | `null` / `string` |
| `conversations[].messageCount` | `null` / `number` |
| `conversations[].messages` | `array` |
| `conversations[].messages[]` | `object` |
| `conversations[].messages[].attachments` | `array` |
| `conversations[].messages[].attachments[]` | `object` / `string` |
| `conversations[].messages[].content` | `string` |
| `conversations[].messages[].createdAt` | `null` / `string` |
| `conversations[].messages[].id` | `null` / `string` |
| `conversations[].messages[].parentId` | `null` / `string` |
| `conversations[].messages[].rawContent` | `array` / `null` / `object` / `string` |
| `conversations[].messages[].sender` | `null` / `string` |
| `conversations[].messages[].updatedAt` | `null` / `string` |
| `conversations[].projectId` | `null` / `string` |
| `conversations[].starred` | `boolean` / `null` |
| `conversations[].title` | `string` |
| `conversations[].updatedAt` | `null` / `string` |
| `messageTotal` | `number` |
| `organizationId` | `null` / `string` |
| `profile` | `object` |
| `profile.name` | `null` / `string` |
| `profile.plan` | `null` / `string` |
| `source` | `string` |
| `total` | `number` |

</details>

<a id="claude-projects"></a>
## claude.projects

<details>
<summary>18 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `apiError` | `null` / `string` |
| `organizationId` | `null` / `string` |
| `profile` | `object` |
| `profile.name` | `null` / `string` |
| `profile.plan` | `null` / `string` |
| `projects` | `array` |
| `projects[]` | `object` |
| `projects[].archived` | `boolean` / `null` |
| `projects[].createdAt` | `null` / `string` |
| `projects[].detail` | `array` / `null` / `object` |
| `projects[].fetchError` | `null` / `string` |
| `projects[].href` | `string` |
| `projects[].id` | `null` / `string` |
| `projects[].label` | `null` / `string` |
| `projects[].title` | `string` |
| `projects[].updatedAt` | `null` / `string` |
| `source` | `string` |
| `total` | `number` |

</details>

<a id="claude_code-prompts"></a>
## claude_code.prompts

<details>
<summary>16 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `profile` | `object` |
| `profile.displayName` | `null` / `string` |
| `profile.email` | `null` / `string` |
| `profile.firstStartTime` | `null` / `string` |
| `profile.numStartups` | `null` / `number` |
| `profile.organizationName` | `null` / `string` |
| `profile.plan` | `null` / `string` |
| `prompts` | `array` |
| `prompts[]` | `object` |
| `prompts[].display` | `string` |
| `prompts[].hasPastedContent` | `boolean` |
| `prompts[].project` | `null` / `string` |
| `prompts[].sessionId` | `null` / `string` |
| `prompts[].timestamp` | `null` / `string` |
| `source` | `string` |
| `total` | `number` |

</details>

<a id="claude_code-sessions"></a>
## claude_code.sessions

<details>
<summary>25 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `profile` | `object` |
| `profile.displayName` | `null` / `string` |
| `profile.email` | `null` / `string` |
| `profile.firstStartTime` | `null` / `string` |
| `profile.numStartups` | `null` / `number` |
| `profile.organizationName` | `null` / `string` |
| `profile.plan` | `null` / `string` |
| `sessions` | `array` |
| `sessions[]` | `object` |
| `sessions[].assistantMessageCount` | `number` |
| `sessions[].cliVersion` | `null` / `string` |
| `sessions[].firstTimestamp` | `null` / `string` |
| `sessions[].gitBranch` | `null` / `string` |
| `sessions[].kind` | `null` / `string` |
| `sessions[].lastTimestamp` | `null` / `string` |
| `sessions[].messageCount` | `number` |
| `sessions[].models` | `array` |
| `sessions[].models[]` | `string` |
| `sessions[].parentSessionId` | `null` / `string` |
| `sessions[].project` | `null` / `string` |
| `sessions[].sessionId` | `string` |
| `sessions[].title` | `null` / `string` |
| `sessions[].userMessageCount` | `number` |
| `source` | `string` |
| `total` | `number` |

</details>

<a id="claude_code-trajectories"></a>
## claude_code.trajectories

<details>
<summary>56 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `approximateBytes` | `number` |
| `limits` | `object` |
| `limits.includeThinking` | `boolean` |
| `limits.maxBytes` | `number` |
| `limits.maxStepChars` | `number` |
| `profile` | `object` |
| `profile.displayName` | `null` / `string` |
| `profile.email` | `null` / `string` |
| `profile.firstStartTime` | `null` / `string` |
| `profile.numStartups` | `null` / `number` |
| `profile.organizationName` | `null` / `string` |
| `profile.plan` | `null` / `string` |
| `redactions` | `object` |
| `redactions.byType` | `object` |
| `redactions.byType.*` | `number` |
| `redactions.total` | `number` |
| `sessions` | `array` |
| `sessions[]` | `object` |
| `sessions[].assistantMessageCount` | `number` |
| `sessions[].cliVersion` | `null` / `string` |
| `sessions[].firstTimestamp` | `null` / `string` |
| `sessions[].gitBranch` | `null` / `string` |
| `sessions[].kind` | `null` / `string` |
| `sessions[].lastTimestamp` | `null` / `string` |
| `sessions[].messageCount` | `number` |
| `sessions[].models` | `array` |
| `sessions[].models[]` | `string` |
| `sessions[].parentSessionId` | `null` / `string` |
| `sessions[].project` | `null` / `string` |
| `sessions[].sessionId` | `string` |
| `sessions[].stepCounts` | `object` |
| `sessions[].stepCounts.*` | `number` |
| `sessions[].steps` | `array` |
| `sessions[].steps[]` | `object` |
| `sessions[].steps[].at` | `null` / `string` |
| `sessions[].steps[].callId` | `null` / `string` |
| `sessions[].steps[].index` | `number` |
| `sessions[].steps[].input` | `unspecified` |
| `sessions[].steps[].isError` | `boolean` |
| `sessions[].steps[].model` | `string` |
| `sessions[].steps[].originalLength` | `number` |
| `sessions[].steps[].output` | `string` |
| `sessions[].steps[].role` | `string` |
| `sessions[].steps[].sidechain` | `boolean` |
| `sessions[].steps[].text` | `string` |
| `sessions[].steps[].tool` | `null` / `string` |
| `sessions[].steps[].truncated` | `boolean` |
| `sessions[].steps[].type` | `string` |
| `sessions[].title` | `null` / `string` |
| `sessions[].userMessageCount` | `number` |
| `skippedForBudget` | `number` |
| `source` | `string` |
| `toolCalls` | `number` |
| `total` | `number` |
| `totalSteps` | `number` |
| `truncatedSteps` | `number` |

</details>

<a id="claude_code-usage"></a>
## claude_code.usage

<details>
<summary>43 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `dailyActivity` | `array` |
| `dailyActivity[]` | `object` |
| `dailyActivity[].date` | `string` |
| `dailyActivity[].messageCount` | `number` |
| `dailyActivity[].sessionCount` | `number` |
| `dailyActivity[].toolCallCount` | `number` |
| `dailyModelTokens` | `array` |
| `dailyModelTokens[]` | `object` |
| `dailyModelTokens[].date` | `string` |
| `dailyModelTokens[].tokensByModel` | `object` |
| `hourCounts` | `object` |
| `hourCounts.*` | `number` |
| `longestSession` | `null` / `object` |
| `longestSession.durationMs` | `null` / `number` |
| `longestSession.messageCount` | `null` / `number` |
| `longestSession.sessionId` | `null` / `string` |
| `longestSession.timestamp` | `null` / `string` |
| `models` | `array` |
| `models[]` | `object` |
| `models[].cacheCreationInputTokens` | `number` |
| `models[].cacheReadInputTokens` | `number` |
| `models[].contextWindow` | `null` / `number` |
| `models[].costUSD` | `number` |
| `models[].inputTokens` | `number` |
| `models[].maxOutputTokens` | `null` / `number` |
| `models[].model` | `string` |
| `models[].outputTokens` | `number` |
| `models[].webSearchRequests` | `number` |
| `profile` | `object` |
| `profile.displayName` | `null` / `string` |
| `profile.email` | `null` / `string` |
| `profile.firstStartTime` | `null` / `string` |
| `profile.numStartups` | `null` / `number` |
| `profile.organizationName` | `null` / `string` |
| `profile.plan` | `null` / `string` |
| `source` | `string` |
| `totalCostUSD` | `number` |
| `totals` | `null` / `object` |
| `totals.firstSessionDate` | `null` / `string` |
| `totals.lastComputedDate` | `null` / `string` |
| `totals.messages` | `null` / `number` |
| `totals.sessions` | `null` / `number` |
| `totals.speculationTimeSavedMs` | `null` / `number` |

</details>

<a id="doordash-orders"></a>
## doordash.orders

<details>
<summary>14 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `orders` | `array` |
| `orders[]` | `object` |
| `orders[].date` | `string` |
| `orders[].deliveryAddress` | `string` |
| `orders[].itemCount` | `string` |
| `orders[].items` | `array` |
| `orders[].items[]` | `object` |
| `orders[].items[].name` | `string` |
| `orders[].items[].price` | `string` |
| `orders[].items[].quantity` | `number` |
| `orders[].orderId` | `string` |
| `orders[].restaurant` | `string` |
| `orders[].status` | `string` |
| `orders[].total` | `string` |

</details>

<a id="github-contributions"></a>
## github.contributions

<details>
<summary>18 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `days` | `array` |
| `days[]` | `object` |
| `days[].count` | `number` |
| `days[].date` | `string` |
| `days[].level` | `null` / `number` |
| `fetchedAt` | `string` |
| `monthlyTotals` | `array` |
| `monthlyTotals[]` | `object` |
| `monthlyTotals[].count` | `number` |
| `monthlyTotals[].month` | `string` |
| `topDay` | `null` / `object` |
| `topDay.count` | `number` |
| `topDay.date` | `string` |
| `totalContributionsLastYear` | `null` / `number` |
| `yearTotals` | `array` |
| `yearTotals[]` | `object` |
| `yearTotals[].total` | `number` |
| `yearTotals[].year` | `number` |

</details>

<a id="github-events"></a>
## github.events

<details>
<summary>16 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `events` | `array` |
| `events[]` | `object` |
| `events[].action` | `null` / `string` |
| `events[].body` | `null` / `string` |
| `events[].branch` | `null` / `string` |
| `events[].commits` | `null` / `number` |
| `events[].createdAt` | `string` |
| `events[].id` | `string` |
| `events[].isPublic` | `boolean` |
| `events[].repo` | `string` |
| `events[].repoUrl` | `string` |
| `events[].title` | `null` / `string` |
| `events[].type` | `string` |
| `events[].url` | `null` / `string` |
| `fetchedAt` | `string` |
| `windowDescription` | `string` |

</details>

<a id="github-history"></a>
## github.history

<details>
<summary>42 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `fetchedAt` | `string` |
| `issues` | `array` |
| `issues[]` | `object` |
| `issues[].body` | `null` / `string` |
| `issues[].closedAt` | `null` / `string` |
| `issues[].comments` | `number` |
| `issues[].createdAt` | `null` / `string` |
| `issues[].id` | `string` |
| `issues[].isDraft` | `boolean` |
| `issues[].labels` | `array` |
| `issues[].labels[]` | `string` |
| `issues[].mergedAt` | `null` / `string` |
| `issues[].number` | `null` / `number` |
| `issues[].reactionsTotal` | `number` |
| `issues[].repo` | `string` |
| `issues[].repoUrl` | `null` / `string` |
| `issues[].state` | `null` / `string` |
| `issues[].title` | `null` / `string` |
| `issues[].type` | `string` |
| `issues[].updatedAt` | `null` / `string` |
| `issues[].url` | `null` / `string` |
| `pullRequests` | `array` |
| `pullRequests[]` | `object` |
| `pullRequests[].body` | `null` / `string` |
| `pullRequests[].closedAt` | `null` / `string` |
| `pullRequests[].comments` | `number` |
| `pullRequests[].createdAt` | `null` / `string` |
| `pullRequests[].id` | `string` |
| `pullRequests[].isDraft` | `boolean` |
| `pullRequests[].labels` | `array` |
| `pullRequests[].labels[]` | `string` |
| `pullRequests[].mergedAt` | `null` / `string` |
| `pullRequests[].number` | `null` / `number` |
| `pullRequests[].reactionsTotal` | `number` |
| `pullRequests[].repo` | `string` |
| `pullRequests[].repoUrl` | `null` / `string` |
| `pullRequests[].state` | `null` / `string` |
| `pullRequests[].title` | `null` / `string` |
| `pullRequests[].type` | `string` |
| `pullRequests[].updatedAt` | `null` / `string` |
| `pullRequests[].url` | `null` / `string` |
| `windowDescription` | `string` |

</details>

<a id="github-profile"></a>
## github.profile

<details>
<summary>29 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `achievements` | `array` |
| `achievements[]` | `object` |
| `achievements[].iconUrl` | `null` / `string` |
| `achievements[].name` | `string` |
| `avatarUrl` | `string` |
| `bio` | `string` |
| `company` | `string` |
| `contributionsLastYear` | `null` / `number` |
| `followers` | `number` |
| `following` | `number` |
| `fullName` | `string` |
| `location` | `string` |
| `organizations` | `array` |
| `organizations[]` | `object` |
| `organizations[].avatarUrl` | `null` / `string` |
| `organizations[].label` | `string` |
| `organizations[].login` | `string` |
| `organizations[].url` | `string` |
| `pinnedRepositories` | `array` |
| `pinnedRepositories[]` | `object` |
| `pinnedRepositories[].description` | `string` |
| `pinnedRepositories[].fullName` | `string` |
| `pinnedRepositories[].language` | `null` / `string` |
| `pinnedRepositories[].stars` | `number` |
| `pinnedRepositories[].url` | `null` / `string` |
| `profileUrl` | `string` |
| `repositoryCount` | `number` |
| `username` | `string` |
| `website` | `string` |

</details>

<a id="github-repositories"></a>
## github.repositories

<details>
<summary>12 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `repositories` | `array` |
| `repositories[]` | `object` |
| `repositories[].description` | `string` |
| `repositories[].forks` | `number` |
| `repositories[].language` | `string` |
| `repositories[].name` | `string` |
| `repositories[].stars` | `number` |
| `repositories[].topics` | `array` |
| `repositories[].topics[]` | `string` |
| `repositories[].updatedAt` | `null` / `string` |
| `repositories[].url` | `string` |
| `repositories[].visibility` | `string` |

</details>

<a id="github-starred"></a>
## github.starred

<details>
<summary>8 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `starred` | `array` |
| `starred[]` | `object` |
| `starred[].description` | `string` |
| `starred[].fullName` | `string` |
| `starred[].language` | `string` |
| `starred[].stars` | `number` |
| `starred[].updatedAt` | `null` / `string` |
| `starred[].url` | `string` |

</details>

<a id="heb-nutrition"></a>
## heb.nutrition

<details>
<summary>37 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `coverage` | `object` |
| `coverage.found` | `number` |
| `coverage.foundUSDA` | `number` |
| `coverage.percentCovered` | `number` |
| `coverage.total` | `number` |
| `items` | `object` |
| `items.*` | `object` |
| `items.*.added_sugar_g` | `null` / `number` |
| `items.*.allergens` | `null` / `string` |
| `items.*.calcium_mg` | `null` / `number` |
| `items.*.calories` | `null` / `number` |
| `items.*.carbs_g` | `null` / `number` |
| `items.*.category` | `array` / `null` / `string` |
| `items.*.category[]` | `string` |
| `items.*.cholesterol_mg` | `null` / `number` |
| `items.*.confidence` | `string` |
| `items.*.fat_g` | `null` / `number` |
| `items.*.fiber_g` | `null` / `number` |
| `items.*.highlights` | `array` / `null` |
| `items.*.highlights[]` | `string` |
| `items.*.images` | `null` / `object` / `string` |
| `items.*.images.full` | `string` |
| `items.*.images.thumbnail` | `string` |
| `items.*.ingredients` | `null` / `string` |
| `items.*.iron_mg` | `null` / `number` |
| `items.*.name` | `string` |
| `items.*.potassium_mg` | `null` / `number` |
| `items.*.protein_g` | `null` / `number` |
| `items.*.saturated_fat_g` | `null` / `number` |
| `items.*.servingSize` | `null` / `string` |
| `items.*.servingsPerContainer` | `null` / `string` |
| `items.*.sodium_mg` | `null` / `number` |
| `items.*.source` | `string` |
| `items.*.sugar_g` | `null` / `number` |
| `items.*.trans_fat_g` | `null` / `number` |
| `items.*.upc` | `null` / `string` |
| `items.*.vitamin_d_mcg` | `null` / `number` |

</details>

<a id="heb-orders"></a>
## heb.orders

<details>
<summary>19 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `orders` | `array` |
| `orders[]` | `object` |
| `orders[].address` | `null` / `string` |
| `orders[].itemCount` | `null` / `number` |
| `orders[].items` | `array` |
| `orders[].items[]` | `object` |
| `orders[].items[].imageUrl` | `null` / `string` |
| `orders[].items[].name` | `string` |
| `orders[].items[].price` | `null` / `number` |
| `orders[].items[].productId` | `string` |
| `orders[].items[].productUrl` | `null` / `string` |
| `orders[].items[].quantity` | `null` / `string` |
| `orders[].orderDate` | `null` / `string` |
| `orders[].orderId` | `string` |
| `orders[].orderUrl` | `string` |
| `orders[].status` | `null` / `string` |
| `orders[].total` | `null` / `number` |
| `totalItems` | `number` |
| `totalOrders` | `number` |

</details>

<a id="heb-profile"></a>
## heb.profile

<details>
<summary>8 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `deliveryAddresses` | `array` |
| `deliveryAddresses[]` | `object` |
| `deliveryAddresses[].address` | `string` |
| `deliveryAddresses[].isPrimary` | `boolean` |
| `deliveryAddresses[].label` | `null` / `string` |
| `email` | `null` / `string` |
| `name` | `null` / `string` |
| `phone` | `null` / `string` |

</details>

<a id="icloud_notes-folders"></a>
## icloud_notes.folders

<details>
<summary>5 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `folders` | `array` |
| `folders[]` | `object` |
| `folders[].recordName` | `string` |
| `folders[].title` | `string` |
| `total` | `number` |

</details>

<a id="icloud_notes-notes"></a>
## icloud_notes.notes

<details>
<summary>13 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `notes` | `array` |
| `notes[]` | `object` |
| `notes[].createdDate` | `null` / `string` |
| `notes[].folder` | `null` / `string` |
| `notes[].hasAttachments` | `boolean` |
| `notes[].isPinned` | `boolean` |
| `notes[].modifiedDate` | `null` / `string` |
| `notes[].recordName` | `string` |
| `notes[].snippet` | `null` / `string` |
| `notes[].textContent` | `null` / `string` |
| `notes[].title` | `null` / `string` |
| `total` | `number` |
| `userName` | `null` / `string` |

</details>

<a id="instagram-ads"></a>
## instagram.ads

<details>
<summary>10 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `ad_topics` | `array` |
| `ad_topics[]` | `object` |
| `ad_topics[].name` | `string` |
| `advertisers` | `array` |
| `advertisers[]` | `object` |
| `advertisers[].name` | `string` |
| `categories` | `array` |
| `categories[]` | `object` |
| `categories[].description` | `null` / `string` |
| `categories[].name` | `string` |

</details>

<a id="instagram-following"></a>
## instagram.following

<details>
<summary>9 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `accounts` | `array` |
| `accounts[]` | `object` |
| `accounts[].full_name` | `string` |
| `accounts[].is_private` | `boolean` |
| `accounts[].is_verified` | `boolean` |
| `accounts[].pk` | `string` |
| `accounts[].profile_pic_url` | `null` / `string` |
| `accounts[].username` | `string` |
| `total` | `number` |

</details>

<a id="instagram-posts"></a>
## instagram.posts

<details>
<summary>12 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `posts` | `array` |
| `posts[]` | `object` |
| `posts[].caption` | `string` |
| `posts[].img_url` | `string` |
| `posts[].num_of_likes` | `number` |
| `posts[].taken_at` | `string` |
| `posts[].who_liked` | `array` |
| `posts[].who_liked[]` | `object` |
| `posts[].who_liked[].id` | `string` |
| `posts[].who_liked[].pk` | `string` |
| `posts[].who_liked[].profile_pic_url` | `string` |
| `posts[].who_liked[].username` | `string` |

</details>

<a id="instagram-profile"></a>
## instagram.profile

<details>
<summary>11 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `bio` | `string` |
| `external_url` | `string` |
| `follower_count` | `number` |
| `following_count` | `number` |
| `full_name` | `string` |
| `is_business` | `boolean` |
| `is_private` | `boolean` |
| `is_verified` | `boolean` |
| `media_count` | `number` |
| `profile_pic_url` | `string` |
| `username` | `string` |

</details>

<a id="linkedin-connections"></a>
## linkedin.connections

<details>
<summary>6 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `connections` | `array` |
| `connections[]` | `object` |
| `connections[].dateConnected` | `string` |
| `connections[].fullName` | `string` |
| `connections[].headline` | `string` |
| `connections[].profileUrl` | `string` |

</details>

<a id="linkedin-education"></a>
## linkedin.education

<details>
<summary>7 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `education` | `array` |
| `education[]` | `object` |
| `education[].degree` | `string` |
| `education[].grade` | `string` |
| `education[].logoUrl` | `string` |
| `education[].schoolName` | `string` |
| `education[].years` | `string` |

</details>

<a id="linkedin-experience"></a>
## linkedin.experience

<details>
<summary>7 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `experiences` | `array` |
| `experiences[]` | `object` |
| `experiences[].companyName` | `string` |
| `experiences[].dates` | `string` |
| `experiences[].description` | `string` |
| `experiences[].jobTitle` | `string` |
| `experiences[].location` | `string` |

</details>

<a id="linkedin-languages"></a>
## linkedin.languages

<details>
<summary>4 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `languages` | `array` |
| `languages[]` | `object` |
| `languages[].name` | `string` |
| `languages[].proficiency` | `string` |

</details>

<a id="linkedin-profile"></a>
## linkedin.profile

<details>
<summary>7 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `about` | `string` |
| `connections` | `string` |
| `fullName` | `string` |
| `headline` | `string` |
| `location` | `string` |
| `profilePictureUrl` | `string` |
| `profileUrl` | `string` |

</details>

<a id="linkedin-skills"></a>
## linkedin.skills

<details>
<summary>4 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `skills` | `array` |
| `skills[]` | `object` |
| `skills[].endorsements` | `string` |
| `skills[].name` | `string` |

</details>

<a id="oura-activity"></a>
## oura.activity

<details>
<summary>23 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `days` | `array` |
| `days[]` | `object` |
| `days[].activeCalories` | `integer` / `null` |
| `days[].contributors` | `object` |
| `days[].contributors.meet_daily_targets` | `integer` / `null` |
| `days[].contributors.move_every_hour` | `integer` / `null` |
| `days[].contributors.recovery_time` | `integer` / `null` |
| `days[].contributors.stay_active` | `integer` / `null` |
| `days[].contributors.training_frequency` | `integer` / `null` |
| `days[].contributors.training_volume` | `integer` / `null` |
| `days[].day` | `string` |
| `days[].equivalentWalkingDistance` | `integer` / `null` |
| `days[].highActivityTime` | `integer` / `null` |
| `days[].id` | `string` |
| `days[].inactivityAlerts` | `integer` / `null` |
| `days[].lowActivityTime` | `integer` / `null` |
| `days[].mediumActivityTime` | `integer` / `null` |
| `days[].restingTime` | `integer` / `null` |
| `days[].score` | `integer` / `null` |
| `days[].sedentaryTime` | `integer` / `null` |
| `days[].steps` | `integer` / `null` |
| `days[].timestamp` | `string` |
| `days[].totalCalories` | `integer` / `null` |

</details>

<a id="oura-readiness"></a>
## oura.readiness

<details>
<summary>17 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `days` | `array` |
| `days[]` | `object` |
| `days[].contributors` | `object` |
| `days[].contributors.activity_balance` | `integer` / `null` |
| `days[].contributors.body_temperature` | `integer` / `null` |
| `days[].contributors.hrv_balance` | `integer` / `null` |
| `days[].contributors.previous_day_activity` | `integer` / `null` |
| `days[].contributors.previous_night` | `integer` / `null` |
| `days[].contributors.recovery_index` | `integer` / `null` |
| `days[].contributors.resting_heart_rate` | `integer` / `null` |
| `days[].contributors.sleep_balance` | `integer` / `null` |
| `days[].day` | `string` |
| `days[].id` | `string` |
| `days[].score` | `integer` / `null` |
| `days[].temperatureDeviation` | `null` / `number` |
| `days[].temperatureTrendDeviation` | `null` / `number` |
| `days[].timestamp` | `string` |

</details>

<a id="oura-sleep"></a>
## oura.sleep

<details>
<summary>34 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `dailyScores` | `array` |
| `dailyScores[]` | `object` |
| `dailyScores[].contributors` | `object` |
| `dailyScores[].contributors.deep_sleep` | `integer` / `null` |
| `dailyScores[].contributors.efficiency` | `integer` / `null` |
| `dailyScores[].contributors.latency` | `integer` / `null` |
| `dailyScores[].contributors.rem_sleep` | `integer` / `null` |
| `dailyScores[].contributors.restfulness` | `integer` / `null` |
| `dailyScores[].contributors.timing` | `integer` / `null` |
| `dailyScores[].contributors.total_sleep` | `integer` / `null` |
| `dailyScores[].day` | `string` |
| `dailyScores[].id` | `string` |
| `dailyScores[].score` | `integer` / `null` |
| `dailyScores[].timestamp` | `string` |
| `sleepPeriods` | `array` |
| `sleepPeriods[]` | `object` |
| `sleepPeriods[].averageBreath` | `null` / `number` |
| `sleepPeriods[].averageHeartRate` | `null` / `number` |
| `sleepPeriods[].averageHrv` | `integer` / `null` |
| `sleepPeriods[].awakeTime` | `integer` / `null` |
| `sleepPeriods[].bedtimeEnd` | `null` / `string` |
| `sleepPeriods[].bedtimeStart` | `null` / `string` |
| `sleepPeriods[].day` | `string` |
| `sleepPeriods[].deepSleepDuration` | `integer` / `null` |
| `sleepPeriods[].efficiency` | `integer` / `null` |
| `sleepPeriods[].id` | `string` |
| `sleepPeriods[].latency` | `integer` / `null` |
| `sleepPeriods[].lightSleepDuration` | `integer` / `null` |
| `sleepPeriods[].lowestHeartRate` | `integer` / `null` |
| `sleepPeriods[].remSleepDuration` | `integer` / `null` |
| `sleepPeriods[].restlessPeriods` | `integer` / `null` |
| `sleepPeriods[].timeInBed` | `integer` / `null` |
| `sleepPeriods[].totalSleepDuration` | `integer` / `null` |
| `sleepPeriods[].type` | `string` |

</details>

<a id="shop-orders"></a>
## shop.orders

<details>
<summary>13 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `orders` | `array` |
| `orders[]` | `object` |
| `orders[].currency` | `string` |
| `orders[].detailUrl` | `string` |
| `orders[].id` | `string` |
| `orders[].itemCount` | `number` |
| `orders[].lineItemTitles` | `array` |
| `orders[].lineItemTitles[]` | `string` |
| `orders[].merchantName` | `string` |
| `orders[].orderNumber` | `string` |
| `orders[].placedAt` | `string` |
| `orders[].status` | `string` |
| `orders[].total` | `number` |

</details>

<a id="spotify-playlists"></a>
## spotify.playlists

<details>
<summary>22 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `playlists` | `array` |
| `playlists[]` | `object` |
| `playlists[].description` | `string` |
| `playlists[].followers` | `number` |
| `playlists[].images` | `array` |
| `playlists[].images[]` | `string` |
| `playlists[].name` | `string` |
| `playlists[].owner` | `string` |
| `playlists[].tracks` | `array` |
| `playlists[].tracks[]` | `object` |
| `playlists[].tracks[].added_at` | `string` |
| `playlists[].tracks[].added_by` | `string` |
| `playlists[].tracks[].album` | `string` |
| `playlists[].tracks[].artists` | `array` |
| `playlists[].tracks[].artists[]` | `object` |
| `playlists[].tracks[].artists[].name` | `string` |
| `playlists[].tracks[].duration_ms` | `number` |
| `playlists[].tracks[].name` | `string` |
| `playlists[].tracks[].uri` | `string` |
| `playlists[].tracks_total` | `number` |
| `playlists[].uri` | `string` |
| `total` | `number` |

</details>

<a id="spotify-profile"></a>
## spotify.profile

<details>
<summary>7 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `display_name` | `string` |
| `followers` | `number` |
| `following` | `number` |
| `id` | `string` |
| `images` | `array` |
| `images[]` | `string` |
| `uri` | `string` |

</details>

<a id="spotify-savedtracks"></a>
## spotify.savedTracks

<details>
<summary>16 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `savedTracks` | `array` |
| `savedTracks[]` | `object` |
| `savedTracks[].added_at` | `string` |
| `savedTracks[].album` | `object` |
| `savedTracks[].album.artists` | `array` |
| `savedTracks[].album.artists[]` | `object` |
| `savedTracks[].album.artists[].name` | `string` |
| `savedTracks[].album.name` | `string` |
| `savedTracks[].artists` | `array` |
| `savedTracks[].artists[]` | `object` |
| `savedTracks[].artists[].name` | `string` |
| `savedTracks[].duration_ms` | `number` |
| `savedTracks[].explicit` | `boolean` |
| `savedTracks[].name` | `string` |
| `savedTracks[].uri` | `string` |
| `total` | `number` |

</details>

<a id="steam-friends"></a>
## steam.friends

<details>
<summary>7 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `[]` | `object` |
| `[].avatarUrl` | `null` / `string` |
| `[].friendSince` | `null` / `string` |
| `[].personaName` | `null` / `string` |
| `[].profileUrl` | `null` / `string` |
| `[].relationship` | `string` |
| `[].steamId` | `string` |

</details>

<a id="steam-games"></a>
## steam.games

<details>
<summary>15 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `owned` | `array` |
| `owned[]` | `object` |
| `owned[].appId` | `integer` |
| `owned[].iconUrl` | `null` / `string` |
| `owned[].lastPlayed` | `null` / `string` |
| `owned[].name` | `string` |
| `owned[].playtimeHours` | `number` |
| `owned[].playtimeMinutes` | `integer` |
| `owned[].playtimeTwoWeeksMinutes` | `integer` |
| `recentlyPlayed` | `array` |
| `recentlyPlayed[]` | `object` |
| `recentlyPlayed[].appId` | `integer` |
| `recentlyPlayed[].name` | `string` |
| `recentlyPlayed[].playtimeForeverMinutes` | `integer` |
| `recentlyPlayed[].playtimeTwoWeeksMinutes` | `integer` |

</details>

<a id="steam-profile"></a>
## steam.profile

<details>
<summary>13 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `accountCreated` | `null` / `string` |
| `avatarUrl` | `string` |
| `cityId` | `integer` / `null` |
| `communityVisibilityState` | `integer` |
| `country` | `null` / `string` |
| `lastLogoff` | `null` / `string` |
| `personaName` | `string` |
| `personaState` | `integer` |
| `profileUrl` | `string` |
| `realName` | `null` / `string` |
| `state` | `null` / `string` |
| `steamId` | `string` |
| `steamLevel` | `integer` / `null` |

</details>

<a id="uber-receipts"></a>
## uber.receipts

<details>
<summary>12 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `receipts` | `array` |
| `receipts[]` | `object` |
| `receipts[].currencyCode` | `string` |
| `receipts[].distance` | `string` |
| `receipts[].distanceLabel` | `string` |
| `receipts[].duration` | `string` |
| `receipts[].durationLabel` | `string` |
| `receipts[].fare` | `string` |
| `receipts[].fareBreakdown` | `string` |
| `receipts[].surgeMultiplier` | `string` |
| `receipts[].tripId` | `string` |
| `receipts[].vehicleType` | `string` |

</details>

<a id="uber-trips"></a>
## uber.trips

<details>
<summary>13 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `trips` | `array` |
| `trips[]` | `object` |
| `trips[].city` | `string` |
| `trips[].currencyCode` | `string` |
| `trips[].dropoffAddress` | `string` |
| `trips[].dropoffTime` | `string` |
| `trips[].fare` | `string` |
| `trips[].id` | `string` |
| `trips[].isSurge` | `boolean` |
| `trips[].pickupAddress` | `string` |
| `trips[].requestTime` | `string` |
| `trips[].status` | `string` |
| `trips[].vehicleType` | `string` |

</details>

<a id="wholefoods-nutrition"></a>
## wholefoods.nutrition

<details>
<summary>19 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `coverage` | `object` |
| `coverage.found` | `number` |
| `coverage.foundUSDA` | `number` |
| `coverage.percentCovered` | `number` |
| `coverage.total` | `number` |
| `items` | `object` |
| `items.*` | `object` |
| `items.*.calories` | `null` / `number` |
| `items.*.carbs_g` | `null` / `number` |
| `items.*.confidence` | `string` |
| `items.*.fat_g` | `null` / `number` |
| `items.*.fiber_g` | `null` / `number` |
| `items.*.name` | `string` |
| `items.*.protein_g` | `null` / `number` |
| `items.*.servingSize` | `null` / `string` |
| `items.*.servingsPerContainer` | `null` / `string` |
| `items.*.sodium_mg` | `null` / `number` |
| `items.*.source` | `string` |
| `items.*.sugar_g` | `null` / `number` |

</details>

<a id="wholefoods-orders"></a>
## wholefoods.orders

<details>
<summary>18 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `orders` | `array` |
| `orders[]` | `object` |
| `orders[].itemCount` | `null` / `number` |
| `orders[].items` | `array` |
| `orders[].items[]` | `object` |
| `orders[].items[].imageUrl` | `string` |
| `orders[].items[].name` | `string` |
| `orders[].items[].price` | `null` / `number` |
| `orders[].items[].productId` | `string` |
| `orders[].items[].productUrl` | `string` |
| `orders[].items[].quantity` | `null` / `string` |
| `orders[].orderDate` | `null` / `string` |
| `orders[].orderId` | `string` |
| `orders[].orderUrl` | `string` |
| `orders[].status` | `null` / `string` |
| `orders[].total` | `null` / `number` |
| `totalItems` | `number` |
| `totalOrders` | `number` |

</details>

<a id="wholefoods-profile"></a>
## wholefoods.profile

<details>
<summary>2 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `email` | `null` / `string` |
| `name` | `null` / `string` |

</details>

<a id="youtube-history"></a>
## youtube.history

<details>
<summary>11 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `history` | `array` |
| `history[]` | `object` |
| `history[].channelTitle` | `null` / `string` |
| `history[].description` | `null` / `string` |
| `history[].videoId` | `null` / `string` |
| `history[].videoTitle` | `null` / `string` |
| `history[].videoUrl` | `string` |
| `history[].views` | `null` / `string` |
| `history[].watchedAt` | `null` / `string` |
| `history[].watchedAtText` | `null` / `string` |
| `timeWindow` | `string` |

</details>

<a id="youtube-likes"></a>
## youtube.likes

<details>
<summary>9 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `likedVideos` | `array` |
| `likedVideos[]` | `object` |
| `likedVideos[].channelTitle` | `null` / `string` |
| `likedVideos[].channelUrl` | `null` / `string` |
| `likedVideos[].durationText` | `null` / `string` |
| `likedVideos[].thumbnailUrl` | `null` / `string` |
| `likedVideos[].videoId` | `null` / `string` |
| `likedVideos[].videoTitle` | `string` |
| `likedVideos[].videoUrl` | `string` |

</details>

<a id="youtube-playlistitems"></a>
## youtube.playlistItems

<details>
<summary>14 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `playlists` | `array` |
| `playlists[]` | `object` |
| `playlists[].items` | `array` |
| `playlists[].items[]` | `object` |
| `playlists[].items[].channelTitle` | `null` / `string` |
| `playlists[].items[].channelUrl` | `null` / `string` |
| `playlists[].items[].durationText` | `null` / `string` |
| `playlists[].items[].thumbnailUrl` | `null` / `string` |
| `playlists[].items[].videoId` | `null` / `string` |
| `playlists[].items[].videoTitle` | `string` |
| `playlists[].items[].videoUrl` | `string` |
| `playlists[].playlistId` | `string` |
| `playlists[].playlistTitle` | `null` / `string` |
| `playlists[].playlistUrl` | `null` / `string` |

</details>

<a id="youtube-playlists"></a>
## youtube.playlists

<details>
<summary>10 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `playlists` | `array` |
| `playlists[]` | `object` |
| `playlists[].owner` | `null` / `string` |
| `playlists[].ownerUrl` | `null` / `string` |
| `playlists[].playlistId` | `string` |
| `playlists[].privacy` | `null` / `string` |
| `playlists[].title` | `null` / `string` |
| `playlists[].url` | `string` |
| `playlists[].videoCount` | `null` / `number` |
| `playlists[].views` | `null` / `number` |

</details>

<a id="youtube-profile"></a>
## youtube.profile

<details>
<summary>12 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `avatarUrl` | `null` / `string` |
| `channelId` | `null` / `string` |
| `channelTitle` | `null` / `string` |
| `channelUrl` | `null` / `string` |
| `country` | `null` / `string` |
| `description` | `null` / `string` |
| `email` | `null` / `string` |
| `handle` | `null` / `string` |
| `joinedDate` | `null` / `string` |
| `subscriberCount` | `null` / `number` |
| `videoCount` | `null` / `number` |
| `viewCount` | `null` / `number` |

</details>

<a id="youtube-subscriptions"></a>
## youtube.subscriptions

<details>
<summary>12 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `subscriptions` | `array` |
| `subscriptions[]` | `object` |
| `subscriptions[].avatarUrl` | `null` / `string` |
| `subscriptions[].channelId` | `null` / `string` |
| `subscriptions[].channelTitle` | `string` |
| `subscriptions[].channelUrl` | `string` |
| `subscriptions[].description` | `null` / `string` |
| `subscriptions[].handle` | `null` / `string` |
| `subscriptions[].isBellNotification` | `boolean` |
| `subscriptions[].isVerified` | `boolean` |
| `subscriptions[].subscriberCount` | `null` / `number` |
| `subscriptions[].subscriberCountText` | `null` / `string` |

</details>

<a id="youtube-watchlater"></a>
## youtube.watchLater

<details>
<summary>9 declared paths</summary>

| Path | Declared type |
| --- | --- |
| `watchLater` | `array` |
| `watchLater[]` | `object` |
| `watchLater[].channelTitle` | `null` / `string` |
| `watchLater[].channelUrl` | `null` / `string` |
| `watchLater[].durationText` | `null` / `string` |
| `watchLater[].thumbnailUrl` | `null` / `string` |
| `watchLater[].videoId` | `null` / `string` |
| `watchLater[].videoTitle` | `string` |
| `watchLater[].videoUrl` | `string` |

</details>
