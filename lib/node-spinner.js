// Node fallback for bare-spinner, which is Bare-only (it pulls in bare-process
// -> bare-abort, a native addon). No animation, just the final status lines.
const unicode =
  process.platform !== 'win32' ||
  Boolean(process.env.WT_SESSION) ||
  process.env.TERM_PROGRAM === 'vscode'

const symbols = unicode
  ? { success: '✔', error: '✖', warning: '⚠', info: 'ℹ' }
  : { success: '√', error: '×', warning: '‼', info: 'i' }

class Spinner {
  constructor(options = {}) {
    this.text = options.text ?? ''
    this.stream = options.stream ?? process.stderr
  }

  start(text) {
    if (text) this.text = text
    return this
  }

  stop(finalText) {
    if (finalText) this.stream.write(`${finalText}\n`)
    return this
  }

  success(text) {
    return this.stop(`${symbols.success} ${text ?? this.text}`)
  }

  error(text) {
    return this.stop(`${symbols.error} ${text ?? this.text}`)
  }

  warning(text) {
    return this.stop(`${symbols.warning} ${text ?? this.text}`)
  }

  info(text) {
    return this.stop(`${symbols.info} ${text ?? this.text}`)
  }
}

module.exports = { default: (options) => new Spinner(options) }
