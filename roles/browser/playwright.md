## Browser: Playwright

You have your own headless browser through the Playwright tools (`mcp__playwright__*`). It belongs to you alone, so you don't need to take any lock, and other tasks can test at the same time.

- It starts empty and logged out on each run. Open the repo's local URL with the navigate tool.
- It can only load this project's local URLs, so don't try other sites.
- Read the page with the snapshot tool. It's cheaper and more exact than a screenshot. Use screenshots for visual checks and as evidence.
- Screenshots go to the `qa-evidence` folder in the task folder. Name each one after what it shows, such as `ac2-empty-name-error.png`, and cite the files in your report.
- Check the console messages and network requests for errors after each flow.
- For phone layouts, resize the browser.
- Close the browser when you're done.
