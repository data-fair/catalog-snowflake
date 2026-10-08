import type { LogFunctions } from '@data-fair/types-catalogs'
import chalk from 'chalk'
import draftlog from 'draftlog'
import dayjs from 'dayjs'
import localizedFormat from 'dayjs/plugin/localizedFormat.js'

draftlog.into(console)
dayjs.extend(localizedFormat)

const tasksDraftLog: Record<string, any> = {}
const taskInfo: Record<string, { msg: string, total: number }> = {}

/**
 * Creates a visual progress bar
 */
function createProgressBar (progress: number, total: number, width: number = 20): string {
  const percentage = Math.min(100, Math.max(0, (progress / total) * 100))
  const filled = Math.round((percentage / 100) * width)
  const empty = width - filled

  const bar = '█'.repeat(filled) + '░'.repeat(empty)
  const percent = percentage.toFixed(1).padStart(5)

  return `[${bar}] ${percent}% (${progress}/${total})`
}

/**
 * Test utils functions for logging.
 * In the future, this cold be moved to a common library.
 */
export const logFunctions: LogFunctions = {
  info: async (msg, extra) => console.log(chalk.blueBright(`[${dayjs().format('LTS')}][Info] ${msg}`), extra),
  warning: async (msg, extra) => console.log(chalk.yellowBright(`[${dayjs().format('LTS')}][Warning] ${msg}`), extra),
  error: async (msg, extra) => console.log(chalk.red(`[${dayjs().format('LTS')}][Error] ${msg}`), extra),
  step: async (msg) => console.log(chalk.blueBright.bold.underline(`[${dayjs().format('LTS')}][Step] ${msg}`)),
  task: async (key, msg, total) => {
    tasksDraftLog[key] = console.draft()
    taskInfo[key] = { msg, total }
    const progressBar = createProgressBar(0, total)
    tasksDraftLog[key](chalk.cyanBright(`[${dayjs().format('LTS')}][Task] ${key}: ${msg} ${progressBar}`))
  },
  progress: async (taskKey, progress, total) => {
    if (total) taskInfo[taskKey].total = total
    const progressBar = createProgressBar(progress, total ?? taskInfo[taskKey].total)
    const msg = `[${dayjs().format('LTS')}][Task] ${taskKey}: ${taskInfo[taskKey].msg} ${progressBar}`

    // Update existing draft log
    if (progress >= (total ?? taskInfo[taskKey].total)) tasksDraftLog[taskKey](chalk.greenBright(msg))
    else tasksDraftLog[taskKey](chalk.cyanBright(msg))
  }
}
