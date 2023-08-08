import * as zlib from 'zlib'
import * as util from 'util'

export const inflate = /* @__PURE__ */ util.promisify(zlib.inflate)
export const deflate = /* @__PURE__ */ util.promisify(zlib.deflate)
