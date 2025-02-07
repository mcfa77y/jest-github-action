import * as core from "@actions/core"
import { exec } from "@actions/exec"
import { context, getOctokit } from "@actions/github"
import type { FormattedTestResults } from "@jest/test-result/build"
import type { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods"
import { existsSync, readFileSync } from "fs"
import {
  CoverageMapData,
  CoverageSummary,
  createCoverageMap,
} from "istanbul-lib-coverage"
import filter from "lodash/filter"
import flatMap from "lodash/flatMap"
import path, { join, resolve, sep } from "path"
import strip from "strip-ansi"
const ACTION_NAME = "jest-github-action"
const COVERAGE_HEADER = "# :open_umbrella: Code Coverage"
const CHAR_LIMIT = 60000

const rootPath = process.cwd()

type File = {
  relative: string
  fileName: string
  path: string
  coverage: CoverageSummary
}

export async function run() {
  const workingDirectory = core.getInput("working-directory", { required: false })
  const cwd = workingDirectory ? resolve(workingDirectory) : process.cwd()
  const CWD = cwd + sep
  const RESULTS_FILE = join(CWD, "jest.results.json")
  core.info(`Running tests in ${cwd}`)
  core.info(`Results file: ${RESULTS_FILE}`)
  // test if results file exists
  if (!existsSync(RESULTS_FILE)) {
    core.info(`Results file not found: ${RESULTS_FILE}`)
    core.error(`Results file not found: ${RESULTS_FILE}`)
    core.setFailed(`Results file not found: ${RESULTS_FILE}`)
    return
  }
  try {
    const token = process.env.GITHUB_TOKEN
    if (token === undefined) {
      core.error("GITHUB_TOKEN not set.")
      core.setFailed("GITHUB_TOKEN not set.")
      return
    }

    const cmd = getJestCommand(RESULTS_FILE)
    core.info(`Running jest with command: ${cmd}`)

    const std = await execJest(cmd, CWD)
    core.info(`jest command executed:\n${JSON.stringify(std, null, 2)}`)

    // octokit
    const octokit = getOctokit(token)

    // Parse results
    const results = parseResults(RESULTS_FILE)
    core.info(`Parsed results:\n${JSON.stringify(results, null, 2)}`)

    // Checks
    const checkPayload = getCheckPayload(results, CWD, std)
    core.info(`Check payload:\n${JSON.stringify(checkPayload, null, 2)}`)

    await octokit.rest.checks
      .create(checkPayload)
      .then(() => {
        core.info("Check created")
      })
      .catch((error) => {
        core.error(`Error creating check: ${error}`)
        core.setFailed(`Error creating check: ${error}`)
      })

    // Coverage comments
    if (getPullId() && shouldCommentCoverage()) {
      const comment = getCoverageTable(results, CWD)
      if (comment) {
        await deletePreviousComments(octokit)
        const commentPayload = getCommentPayload(comment)
        await octokit.rest.issues
          .createComment(commentPayload)
          .then(() => {
            core.info("Comment created")
          })
          .catch((error) => {
            core.error(`Error creating comment: ${error}`)
            core.setFailed(`Error creating comment: ${error}`)
          })
      }
    }

    if (!results.success) {
      core.setFailed("Some jest tests failed.")
    }
  } catch (error) {
    console.error(error)
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

async function deletePreviousComments(
  octokit: ReturnType<typeof getOctokit>,
): Promise<Array<any>> {
  const data = await octokit.rest.issues
    .listComments({
      ...context.repo,
      per_page: 100,
      issue_number: getPullId(),
    })
    .then((res) => {
      core.info(`Deleted ${res.data.length} comments`)
      return res.data
    })
    .catch((error) => {
      core.error(`Error getting comments: ${error}`)
      core.setFailed(`Error getting comments: ${error}`)
      throw new Error(`Error getting comments: ${error}`)
    })
  if (!data) {
    return []
  }
  return Promise.all(
    data
      .filter(
        (c) =>
          c.user?.login === "github-actions[bot]" && c.body?.startsWith(COVERAGE_HEADER),
      )
      .map((c) =>
        octokit.rest.issues
          .deleteComment({ ...context.repo, comment_id: c.id })
          .then(() => {
            core.info(`Deleted comment ${c.id}`)
          })
          .catch((error) => {
            core.error(`Error deleting comment: ${error}`)
            core.setFailed(`Error deleting comment: ${error}`)
          }),
      ),
  )
}

function shouldCommentCoverage(): boolean {
  return Boolean(JSON.parse(core.getInput("coverage-comment", { required: false })))
}

function shouldRunOnlyChangedFiles(): boolean {
  return Boolean(JSON.parse(core.getInput("changes-only", { required: false })))
}

function formatIfPoor(number: number): string {
  if (number > 80) {
    return `${number} :green_circle:`
  }
  if (number > 65) {
    return `${number} :yellow_circle:`
  }
  if (number > 50) {
    return `${number} :orange_circle:`
  }
  return `${number} :red_circle:`
}

const summaryToRow = (f: CoverageSummary): string[] => [
  formatIfPoor(f.statements.pct!),
  formatIfPoor(f.branches.pct!),
  formatIfPoor(f.functions.pct!),
  formatIfPoor(f.lines.pct!),
]

function toHTMLTable(headers: string[], rows: string[][], charLimit = Infinity): string {
  const openingTag = '<table width="100%">'
  const closingTag = "</table>"
  const headerHtml = toHTMLTableRow(
    [headers],
    (cell) => `<th>${cell}</th>`,
    "thead",
    Infinity,
  )
  const remainingChars =
    charLimit === Infinity
      ? Infinity
      : charLimit - (openingTag.length + closingTag.length + headerHtml.length)
  const bodyHtml = toHTMLTableRow(
    rows,
    (cell, i) => `<td${i > 0 ? ' nowrap="nowrap" align="right"' : ""}>${cell}</td>`,
    "tbody",
    remainingChars,
  )

  return [openingTag, headerHtml, bodyHtml, closingTag].join("")
}

function toHTMLTableRow(
  rows: string[][],
  formatCellCB: (cell: string, i: number) => string,
  wrapperElement: string,
  charLimit: number,
): string {
  const openingTag = `<${wrapperElement}>`
  const closingTag = `</${wrapperElement}>`
  let charCount = openingTag.length + closingTag.length
  let truncated = false
  return `${openingTag}${rows
    .map((row) => {
      const rowTag = `<tr>${row.map(formatCellCB).join("")}</tr>`
      charCount += rowTag.length
      if (charCount <= charLimit) {
        return rowTag
      }
      if (truncated) {
        return ""
      }
      truncated = true
      const dummyRow = ["truncated..."].concat(
        Array(Math.max((rows[0] ?? []).length - 1, 0)).fill(""),
      )
      return `<tr>${dummyRow.map(formatCellCB).join("")}</tr>`
    })
    .join("")}${closingTag}`
}

const groupByPath = (
  dirs: { [key: string]: File[] },
  file: File,
): { [key: string]: File[] } => {
  if (!(file.path in dirs)) {
    dirs[file.path] = []
  }

  dirs[file.path].push(file)

  return dirs
}

function truncateLeft(str: string, len: number): string {
  if (len > str.length) {
    return str
  }

  const subStr = str.substring(str.length - len)

  return `...${subStr}`
}

function truncateRight(str: string, len: number): string {
  if (len > str.length) {
    return str
  }

  const subStr = str.substring(0, len)

  return `${subStr}...`
}

export function getCoverageTable(
  results: FormattedTestResults,
  cwd: string,
): string | false {
  if (!results.coverageMap) {
    core.warning("No coverage map found")
    return ""
  }
  const coverageMap = createCoverageMap(results.coverageMap as unknown as CoverageMapData)

  if (!Object.keys(coverageMap.data).length) {
    core.warning("No entries found in coverage data")
    return ""
  }

  const headers = ["% Stmts", "% Branch", "% Funcs", "% Lines"]
  const summary = summaryToRow(coverageMap.getCoverageSummary())
  const summaryTable = toHTMLTable(headers, [summary])

  const parseFile = (absolute: string) => {
    const relative = path.relative(rootPath, absolute)
    const fileName = path.basename(relative)
    const p = path.dirname(relative)
    const coverage = coverageMap.fileCoverageFor(absolute).toSummary()
    return { relative, fileName, path: p, coverage }
  }
  const fullHeaders = ["File", ...headers]
  const files = coverageMap.files().map(parseFile).reduce(groupByPath, {})
  const rows = Object.entries(files)
    .map(([dir, files]) => [
      [`<b>${truncateLeft(dir, 50)}</b>`, "", "", "", ""], // Add metrics for directories by summing files
      ...files.map((file) => [
        `<code>${file.fileName}</code>`,
        ...summaryToRow(file.coverage),
      ]),
    ])
    .flat()
  const fullTable = toHTMLTable(fullHeaders, rows, CHAR_LIMIT)

  const lines = [
    COVERAGE_HEADER,
    summaryTable,
    "",
    "<details>",
    "<summary>Click to expand</summary>\n",
    fullTable,
    "</details>",
  ]
  return lines.join("\n")
}

function getCommentPayload(
  body: string,
): RestEndpointMethodTypes["issues"]["createComment"]["parameters"] {
  const payload: RestEndpointMethodTypes["issues"]["createComment"]["parameters"] = {
    ...context.repo,
    body,
    issue_number: getPullId(),
  }
  return payload
}

function getCheckPayload(
  results: FormattedTestResults,
  cwd: string,
  { out, err }: { out?: string; err?: string },
): RestEndpointMethodTypes["checks"]["create"]["parameters"] {
  const payload: RestEndpointMethodTypes["checks"]["create"]["parameters"] = {
    ...context.repo,
    head_sha: getSha(),
    name: ACTION_NAME,
    status: "completed",
    conclusion: results.success ? "success" : "failure",
    output: {
      title: results.success ? "Jest tests passed" : "Jest tests failed",
      text: truncateRight(`${out ? out : ""}${err ? `\n\n${err}` : ""}`, CHAR_LIMIT),
      summary: results.success
        ? `${results.numPassedTests} tests passing in ${
            results.numPassedTestSuites
          } suite${results.numPassedTestSuites > 1 ? "s" : ""}.`
        : `Failed tests: ${results.numFailedTests}/${results.numTotalTests}. Failed suites: ${results.numFailedTests}/${results.numTotalTestSuites}.`,

      annotations: getAnnotations(results, cwd),
    },
  }
  return payload
}

function getJestCommand(resultsFile: string): string {
  let cmd = core.getInput("test-command", { required: false })
  const jestOptions = `--testLocationInResults --json ${
    shouldCommentCoverage() ? "--coverage" : ""
  } ${
    shouldRunOnlyChangedFiles() && context.payload.pull_request?.base.ref
      ? "--changedSince=" + context.payload.pull_request?.base.ref
      : ""
  } --outputFile=${resultsFile}`
  const shouldAddHyphen =
    cmd.startsWith("npm") ||
    cmd.startsWith("npx") ||
    cmd.startsWith("pnpm") ||
    cmd.startsWith("pnpx")
  cmd += (shouldAddHyphen ? " -- " : " ") + jestOptions
  return cmd
}

function parseResults(resultsFile: string): FormattedTestResults {
  return JSON.parse(readFileSync(resultsFile, "utf-8"))
}

async function execJest(
  cmd: string,
  cwd?: string,
): Promise<{ out: string; err: string }> {
  let out = Buffer.concat([], 0)
  let err = Buffer.concat([], 0)

  try {
    const options: Parameters<typeof exec>[2] = {
      cwd,
      silent: true,
    }
    options.listeners = {
      stdout: (data: Buffer) => {
        out = Buffer.concat([out, data], out.length + data.length)
      },
      stderr: (data: Buffer) => {
        err = Buffer.concat([err, data], err.length + data.length)
      },
    }
    await exec(cmd, [], options)

    core.info("Jest command executed")
  } catch (e) {
    core.error(`Jest execution failed. Tests have likely failed.\n${JSON.stringify(e)}`)
  }

  return { out: out.toString(), err: err.toString() }
}

function getPullId(): number {
  const pullId = context.payload.pull_request?.number ?? 0
  core.info(`Pull ID: ${pullId}`)
  return pullId
}

function getSha(): string {
  const sha = context.payload.pull_request?.head.sha ?? context.sha
  core.info(`SHA: ${sha}`)
  return sha
}

const getAnnotations = (
  results: FormattedTestResults,
  cwd: string,
): NonNullable<
  RestEndpointMethodTypes["checks"]["create"]["parameters"]["output"]
>["annotations"] => {
  if (results.success) {
    return []
  }
  const annotations = flatMap(results.testResults, (result) => {
    return filter(result.assertionResults, ["status", "failed"]).map((assertion) => ({
      path: result.name.replace(cwd, ""),
      start_line: assertion.location?.line ?? 0,
      end_line: assertion.location?.line ?? 0,
      annotation_level: "failure" as "failure" | "notice" | "warning",
      title: assertion.ancestorTitles.concat(assertion.title).join(" > "),
      message: strip(assertion.failureMessages?.join("\n\n") ?? ""),
    }))
  })
  core.info(`Annotations: ${JSON.stringify(annotations, null, 2)}`)
  return annotations
}

export function asMarkdownCode(str: string): string {
  return "```\n" + str.trimEnd() + "\n```"
}
