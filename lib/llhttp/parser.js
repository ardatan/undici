/**
 * Minimal HTTP response parser using a wasm build of llhttp.
 * This is based on the work made by devsnek in https://github.com/devsnek/llhttp/tree/wasm
 *
 * The wasm build is currently imeplemented in a custom repo:
 * https://github.com/dnlup/llhttp/tree/undici_wasm
 */

'use strict'

/* global WebAssembly */

const { resolve } = require('path')
const { readFileSync } = require('fs')
const constants = require('./constants')
const { kMaxHeadersSize } = require('../core/symbols')
const assert = require('assert')
const WASM_BUILD = resolve(__dirname, './llhttp.wasm')
const bin = readFileSync(WASM_BUILD)
const mod = new WebAssembly.Module(bin)

const kOnMessageBegin = 0
const kOnHeadersComplete = 1
const kOnBody = 2
const kOnMessageComplete = 3
const kOnUpgrade = 4

const kPtr = Symbol('kPrt')
const kHeaders = Symbol('kHeaders')
const kHeaderSize = Symbol('kHeaderSize')
const kBufferSize = Symbol('kBufferSize')
const kBufferPtr = Symbol('kBufferPtr')
const kBufferView = Symbol('kBufferView')

/**
 * Current parser reference
 */
let currentParser = null

const cstr = (ptr, len) =>
  Buffer.from(inst.exports.memory.buffer, ptr, len).toString()

/* eslint-disable camelcase */
const wasm_on_message_begin = p => {
  return currentParser[kOnMessageBegin]()
}

const wasm_on_url = (p, at, length) => {
  return 0
}

const wasm_on_status = (p, at, length) => {
  return 0
}

const wasm_on_header_field = (p, at, length) => {
  this[kHeaderSize] += length
  if (this[kHeaderSize] >= this[kMaxHeadersSize]) {
    inst.exports.llhttp_set_error_reason(this[kPtr], 'HPE_HEADER_OVERFLOW:Header overflow')
    return constants.ERROR.USER
  }
  currentParser[kHeaders].push(cstr(at, length))
  return 0
}

const wasm_on_header_value = wasm_on_header_field

const wasm_on_headers_complete = p => {
  const versionMajor = inst.exports.llhttp_get_http_major(p)
  const versionMinor = inst.exports.llhttp_get_http_minor(p)
  const rawHeaders = currentParser[kHeaders]
  const statusCode = inst.exports.llhttp_get_status_code(p)
  const statusMessage = ''
  const upgrade = Boolean(inst.exports.llhttp_get_upgrade(p))
  const shouldKeepAlive = Boolean(inst.exports.llhttp_should_keep_alive(p))

  currentParser[kHeaders] = []
  currentParser[kHeaderSize] = 0

  return currentParser[kOnHeadersComplete](versionMajor, versionMinor, rawHeaders, null,
    null, statusCode, statusMessage, upgrade, shouldKeepAlive)
}

const wasm_on_body = (p, at, length) => {
  // TODO: we could optimize this further by making this part responsibility fo the user.
  // Forcing them to consume the buffer synchronously or copy it otherwise.
  // See https://github.com/nodejs/undici/pull/575#discussion_r588885738
  const body = Buffer.from(inst.exports.memory.buffer, at, length) // llhttp re-uses buffer so we need to make a copy.
  currentParser[kOnBody](body)
  return 0
}

const wasm_on_message_complete = (p) => {
  const rawHeaders = currentParser[kHeaders]

  currentParser[kHeaders] = []
  currentParser[kHeaderSize] = 0

  currentParser[kOnMessageComplete](rawHeaders)
  return 0
}

/* eslint-enable camelcase */

const inst = new WebAssembly.Instance(mod, {
  env: {
    wasm_on_message_begin,
    wasm_on_url,
    wasm_on_status,
    wasm_on_header_field,
    wasm_on_header_value,
    wasm_on_headers_complete,
    wasm_on_body,
    wasm_on_message_complete
  }
})

inst.exports._initialize() // wasi reactor

class HTTPParserError extends Error {
  constructor (message, code) {
    super(message)
    Error.captureStackTrace(this, HTTPParserError)
    this.name = 'HTTPParserError'
    this.code = code ? `HPE_${code}` : undefined
  }
}

class HTTPParser {
  constructor (maxHeadersSize = 8 * 1024, lenient = false) {
    this[kPtr] = inst.exports.llhttp_alloc(constants.TYPE.RESPONSE)
    this[kBufferSize] = 0
    this[kBufferPtr] = null
    this[kBufferView] = null
    this[kHeaders] = []
    this[kMaxHeadersSize] = maxHeadersSize
    this[kHeaderSize] = 0

    if (lenient === true) {
      inst.exports.llhttp_set_lenient_headers(this[kPtr], 1)
    }
  }

  [kOnMessageBegin] () {
    return 0
  }

  [kOnHeadersComplete] (versionMajor, versionMinor, rawHeaders, method,
    url, statusCode, statusMessage, upgrade, shouldKeepAlive) {
    return 0
  }

  [kOnBody] (body) {
    return 0
  }

  [kOnMessageComplete] () {
    return 0
  }

  [kOnUpgrade] (head) {}

  close () {
    inst.exports.llhttp_free(this[kPtr])
    this[kPtr] = null
    inst.exports.free(this[kBufferPtr])
    this[kBufferPtr] = null
  }

  execute (data) {
    assert(this[kPtr])

    // Be sure the parser buffer can contain `data`
    if (data.length > this[kBufferSize]) {
      if (this[kBufferPtr]) {
        inst.exports.free(this[kBufferPtr])
      }
      this[kBufferSize] = Math.ceil(data.length / 4096) * 4096
      this[kBufferPtr] = inst.exports.malloc(this[kBufferSize])
      // Instantiate a Unit8 Buffer view of the wasm memory that starts from the parser buffer pointer.
      this[kBufferView] = new Uint8Array(inst.exports.memory.buffer, this[kBufferPtr], this[kBufferSize])
    }

    this[kBufferView].set(data)

    // Call `execute` on the wasm parser.
    // We pass the `llhttp_parser` pointer address, the pointer address of buffer view data,
    // and finally the length of bytes to parse.
    // The return value is an error code or `constants.ERROR.OK`.
    // See https://github.com/dnlup/llhttp/blob/undici_wasm/src/native/api.c#L106
    currentParser = this
    const err = inst.exports.llhttp_execute(this[kPtr], this[kBufferPtr], data.length)
    currentParser = null

    if (err === constants.ERROR.PAUSED_UPGRADE) {
      const offset = inst.exports.llhttp_get_error_pos(this[kPtr]) - this[kBufferPtr]
      this[kOnUpgrade](data.slice(offset))
    } else if (err !== constants.ERROR.OK) {
      const ptr = inst.exports.llhttp_get_error_reason(this[kPtr])
      const len = this[kBufferView].indexOf(0, ptr) - ptr
      const message = cstr(ptr, len)
      const code = constants.ERROR[err]
      throw new HTTPParserError(message, code)
    }
  }
}

HTTPParser.kOnMessageBegin = kOnMessageBegin
HTTPParser.kOnHeadersComplete = kOnHeadersComplete
HTTPParser.kOnBody = kOnBody
HTTPParser.kOnMessageComplete = kOnMessageComplete
HTTPParser.kOnUpgrade = kOnUpgrade

module.exports = HTTPParser