// The one place the app's version lives (task-1397). --version, the help banner and `trenchscope update` read it;
// cli.test.ts keeps it equal to packages/cli/package.json (release.yml refuses a tag that differs).
export const VERSION = '0.1.5';
