import chalk from "chalk";

export const log = {
  info: (msg: string) => console.log(chalk.cyan(msg)),
  dim: (msg: string) => console.log(chalk.dim(msg)),
  success: (msg: string) => console.log(chalk.green(msg)),
  warn: (msg: string) => console.log(chalk.yellow(msg)),
  error: (msg: string) => console.log(chalk.red(msg)),
  tool: (msg: string) => console.log(chalk.magenta(msg)),
  assistant: (msg: string) => process.stdout.write(chalk.white(msg)),
  diff: (patch: string) => {
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) console.log(chalk.green(line));
      else if (line.startsWith("-") && !line.startsWith("---")) console.log(chalk.red(line));
      else console.log(chalk.dim(line));
    }
  },
};
