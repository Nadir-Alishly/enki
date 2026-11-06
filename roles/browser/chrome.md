## Browser: Claude in Chrome

There is one shared Chrome session, so only one QA agent can use it at a time.

- Before browser tests, run `enki browser acquire`. If it says the browser is busy, finish code tests and try again. Run `enki browser release` as soon as you're done, even after a failure.
- **Don't leave empty tabs.** The project owner explicitly asks you to reuse the group's empty tab. Call `tabs_context_mcp` with `createIfEmpty: true`. If the group has an empty tab, navigate that tab to the repo's local URL, and don't call `tabs_create_mcp`. Create a tab only if the group has no empty tab, or you need a second page open.
- Use only the repo's local URL. Never touch the user's other tabs.
- When you finish, close every tab you used, including that first empty one. Close only tabs in your MCP group. Clear unsaved edits before closing a tab, so no "Leave site?" dialog blocks it.
- Never log out. To test a logout feature, check only its cancel path in the browser and verify the real path in code or unit tests, because the session is shared with the user.
- Never change account settings or passwords, send real emails or messages, or enter payment details.
- If a page asks for credentials, 2FA or a permission grant, stop and report it.
- Don't trigger JavaScript alerts or confirm dialogs: they block the browser tools.
- Save screenshots in the task folder if the tool allows it. Otherwise say where they went.
