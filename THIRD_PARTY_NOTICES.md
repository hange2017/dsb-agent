# Third-Party Notices

This file documents open-source licenses for **production** dependencies of **DSBAgent**
(`dsb-agent`), as resolved from `node_modules` / the lockfile.

Project source code is licensed separately under the root [MIT LICENSE](./LICENSE)
(Copyright (c) 2026 ZhaoNingHan).

> Inventory date: 2026-08-04. Re-run before each public release (`npm run licenses:inventory`).
> Dual-licensed packages (e.g. MIT OR GPL) are used under the permissive MIT option unless noted.

## Summary (production tree)

Total packages scanned: **234**

- MIT: 180
- ISC: 21
- BSD-2-Clause: 15
- BSD-3-Clause: 5
- Apache-2.0: 4
- MIT*: 2
- Unlicense: 1
- Custom: http://github.com/substack/node-bufferlist: 1
- BSD*: 1
- (MIT OR WTFPL): 1
- (MIT OR GPL-3.0-or-later): 1
- (MIT AND Zlib): 1
- (BSD-2-Clause OR MIT OR Apache-2.0): 1

**Review notes**

| Package | License field | Notes |
|---------|---------------|-------|
| `jszip` (transitive, via document tooling) | `(MIT OR GPL-3.0-or-later)` when present | Dual license; this project uses the **MIT** option |
| `better-sqlite3` | MIT (upstream) | `optionalDependencies`; may be absent if native build skipped |

No production packages in this scan were **GPL-only**, AGPL, SSPL, or proprietary (as of inventory date).

## Bundled agent skills (adapted, MIT upstream)

Directory: [`skills/`](./skills/) (shipped inside the extension). Adapted under approach “DSBAgent rewrite” with provenance notices:

| Upstream | License | Bundled as |
|----------|---------|------------|
| [obra/superpowers](https://github.com/obra/superpowers) | MIT © 2025 Jesse Vincent | `skills/sp-*`, `skills/using-dsb-skills` |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | MIT © 2025 Addy Osmani | `skills/as-*` (+ appendix in `using-dsb-skills`) |

Full upstream license texts: [`skills/_notices/`](./skills/_notices/). Regenerate adaptations with:

```bash
node scripts/adapt-bundled-skills.mjs /path/to/superpowers /path/to/agent-skills
```

## Direct runtime / optional dependencies

| Package | Role | License |
|---------|------|---------|
| `@modelcontextprotocol/sdk` | MCP client | MIT |
| `@vscode/ripgrep` | Grep binary helper | MIT |
| `cheerio` | HTML parse (WebFetch/Search) | MIT |
| `mammoth` | DOCX extract | BSD-2-Clause |
| `pdf-parse` | PDF extract | MIT |
| `exceljs` | Spreadsheet extract | MIT |
| `better-sqlite3` | Optional: cc-switch import | MIT |

## Regenerating this file

```bash
npm run licenses:inventory
```

## Full production inventory

| Package | License |
|---------|---------|
| @fast-csv/format@4.3.5 | MIT |
| @fast-csv/parse@4.3.6 | MIT |
| @hono/node-server@2.0.12 | MIT |
| @modelcontextprotocol/sdk@1.30.0 | MIT |
| @types/node@14.18.63 | MIT |
| @vscode/ripgrep-linux-x64@1.18.0 | MIT |
| @vscode/ripgrep@1.18.0 | MIT |
| @xmldom/xmldom@0.8.13 | MIT |
| accepts@2.0.0 | MIT |
| ajv-formats@3.0.1 | MIT |
| ajv@8.20.0 | MIT |
| archiver-utils@2.1.0 | MIT |
| archiver-utils@3.0.4 | MIT |
| archiver@5.3.2 | MIT |
| argparse@1.0.10 | MIT |
| async@3.2.6 | MIT |
| balanced-match@1.0.2 | MIT |
| base64-js@1.5.1 | MIT |
| better-sqlite3@11.10.0 | MIT |
| big-integer@1.6.52 | Unlicense |
| binary@0.3.0 | MIT |
| bindings@1.5.0 | MIT |
| bl@4.1.0 | MIT |
| bluebird@3.4.7 | MIT |
| body-parser@2.3.0 | MIT |
| boolbase@1.0.0 | ISC |
| brace-expansion@1.1.18 | MIT |
| brace-expansion@2.1.4 | MIT |
| buffer-crc32@0.2.13 | MIT |
| buffer-indexof-polyfill@1.0.2 | MIT |
| buffer@5.7.1 | MIT |
| buffers@0.1.1 | Custom: http://github.com/substack/node-bufferlist |
| bytes@3.1.2 | MIT |
| call-bind-apply-helpers@1.0.2 | MIT |
| call-bound@1.0.4 | MIT |
| chainsaw@0.1.0 | MIT* |
| cheerio-select@2.1.0 | BSD-2-Clause |
| cheerio@1.2.0 | MIT |
| chownr@1.1.4 | ISC |
| compress-commons@4.1.2 | MIT |
| concat-map@0.0.1 | MIT |
| content-disposition@1.1.0 | MIT |
| content-type@1.0.5 | MIT |
| content-type@2.0.0 | MIT |
| cookie-signature@1.2.2 | MIT |
| cookie@0.7.2 | MIT |
| core-util-is@1.0.3 | MIT |
| cors@2.8.6 | MIT |
| crc-32@1.2.2 | Apache-2.0 |
| crc32-stream@4.0.3 | MIT |
| cross-spawn@7.0.6 | MIT |
| css-select@5.2.2 | BSD-2-Clause |
| css-what@6.2.2 | BSD-2-Clause |
| dayjs@1.11.21 | MIT |
| debug@4.4.3 | MIT |
| decompress-response@6.0.0 | MIT |
| deep-extend@0.6.0 | MIT |
| depd@2.0.0 | MIT |
| detect-libc@2.1.2 | Apache-2.0 |
| dingbat-to-unicode@1.0.1 | BSD-2-Clause |
| dom-serializer@2.0.0 | MIT |
| domelementtype@2.3.0 | BSD-2-Clause |
| domhandler@5.0.3 | BSD-2-Clause |
| domutils@3.2.2 | BSD-2-Clause |
| dsb-agent@0.1.0 | MIT |
| duck@0.1.12 | BSD* |
| dunder-proto@1.0.1 | MIT |
| duplexer2@0.1.4 | BSD-3-Clause |
| ee-first@1.1.1 | MIT |
| encodeurl@2.0.0 | MIT |
| encoding-sniffer@0.2.1 | MIT |
| end-of-stream@1.4.5 | MIT |
| entities@4.5.0 | BSD-2-Clause |
| entities@6.0.1 | BSD-2-Clause |
| entities@7.0.1 | BSD-2-Clause |
| es-define-property@1.0.1 | MIT |
| es-errors@1.3.0 | MIT |
| es-object-atoms@1.1.2 | MIT |
| escape-html@1.0.3 | MIT |
| etag@1.8.1 | MIT |
| eventsource-parser@3.1.0 | MIT |
| eventsource@3.0.7 | MIT |
| exceljs@4.4.0 | MIT |
| expand-template@2.0.3 | (MIT OR WTFPL) |
| express-rate-limit@8.6.1 | MIT |
| express@5.2.1 | MIT |
| fast-csv@4.3.6 | MIT |
| fast-deep-equal@3.1.3 | MIT |
| fast-uri@3.1.5 | BSD-3-Clause |
| file-uri-to-path@1.0.0 | MIT |
| finalhandler@2.1.1 | MIT |
| forwarded@0.2.0 | MIT |
| fresh@2.0.0 | MIT |
| fs-constants@1.0.0 | MIT |
| fs.realpath@1.0.0 | ISC |
| fstream@1.0.12 | ISC |
| function-bind@1.1.2 | MIT |
| get-intrinsic@1.3.0 | MIT |
| get-proto@1.0.1 | MIT |
| github-from-package@0.0.0 | MIT |
| glob@7.2.3 | ISC |
| gopd@1.2.0 | MIT |
| graceful-fs@4.2.11 | ISC |
| has-symbols@1.1.0 | MIT |
| hasown@2.0.4 | MIT |
| hono@4.12.33 | MIT |
| htmlparser2@10.1.0 | MIT |
| http-errors@2.0.1 | MIT |
| iconv-lite@0.6.3 | MIT |
| iconv-lite@0.7.3 | MIT |
| ieee754@1.2.1 | BSD-3-Clause |
| immediate@3.0.6 | MIT |
| inflight@1.0.6 | ISC |
| inherits@2.0.4 | ISC |
| ini@1.3.8 | ISC |
| ip-address@10.4.0 | MIT |
| ipaddr.js@1.9.1 | MIT |
| is-promise@4.0.0 | MIT |
| isarray@1.0.0 | MIT |
| isexe@2.0.0 | ISC |
| jose@6.2.7 | MIT |
| json-schema-traverse@1.0.0 | MIT |
| json-schema-typed@8.0.2 | BSD-2-Clause |
| jszip@3.10.1 | (MIT OR GPL-3.0-or-later) |
| lazystream@1.0.1 | MIT |
| lie@3.3.0 | MIT |
| listenercount@1.0.1 | ISC |
| lodash.defaults@4.2.0 | MIT |
| lodash.difference@4.5.0 | MIT |
| lodash.escaperegexp@4.1.2 | MIT |
| lodash.flatten@4.4.0 | MIT |
| lodash.groupby@4.6.0 | MIT |
| lodash.isboolean@3.0.3 | MIT |
| lodash.isequal@4.5.0 | MIT |
| lodash.isfunction@3.0.9 | MIT |
| lodash.isnil@4.0.0 | MIT |
| lodash.isplainobject@4.0.6 | MIT |
| lodash.isundefined@3.0.1 | MIT |
| lodash.union@4.6.0 | MIT |
| lodash.uniq@4.5.0 | MIT |
| lop@0.4.2 | BSD-2-Clause |
| mammoth@1.12.0 | BSD-2-Clause |
| math-intrinsics@1.1.0 | MIT |
| media-typer@1.1.1 | MIT |
| merge-descriptors@2.0.0 | MIT |
| mime-db@1.54.0 | MIT |
| mime-types@3.0.2 | MIT |
| mimic-response@3.1.0 | MIT |
| minimatch@3.1.5 | ISC |
| minimatch@5.1.9 | ISC |
| minimist@1.2.8 | MIT |
| mkdirp-classic@0.5.3 | MIT |
| mkdirp@0.5.6 | MIT |
| ms@2.1.3 | MIT |
| napi-build-utils@2.0.0 | MIT |
| negotiator@1.0.0 | MIT |
| node-abi@3.94.0 | MIT |
| node-ensure@0.0.0 | MIT |
| normalize-path@3.0.0 | MIT |
| nth-check@2.1.1 | BSD-2-Clause |
| object-assign@4.1.1 | MIT |
| object-inspect@1.13.4 | MIT |
| on-finished@2.4.1 | MIT |
| once@1.4.0 | ISC |
| option@0.2.4 | BSD-2-Clause |
| pako@1.0.11 | (MIT AND Zlib) |
| parse5-htmlparser2-tree-adapter@7.1.0 | MIT |
| parse5-parser-stream@7.1.2 | MIT |
| parse5@7.3.0 | MIT |
| parseurl@1.3.3 | MIT |
| path-is-absolute@1.0.1 | MIT |
| path-key@3.1.1 | MIT |
| path-to-regexp@8.4.2 | MIT |
| pdf-parse@1.1.4 | MIT |
| pkce-challenge@5.0.1 | MIT |
| prebuild-install@7.1.3 | MIT |
| process-nextick-args@2.0.1 | MIT |
| proxy-addr@2.0.7 | MIT |
| pump@3.0.4 | MIT |
| qs@6.15.3 | BSD-3-Clause |
| range-parser@1.3.0 | MIT |
| raw-body@3.0.2 | MIT |
| rc@1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) |
| readable-stream@2.3.8 | MIT |
| readable-stream@3.6.2 | MIT |
| readdir-glob@1.1.3 | Apache-2.0 |
| require-from-string@2.0.2 | MIT |
| rimraf@2.7.1 | ISC |
| router@2.2.0 | MIT |
| safe-buffer@5.1.2 | MIT |
| safe-buffer@5.2.1 | MIT |
| safer-buffer@2.1.2 | MIT |
| saxes@5.0.1 | ISC |
| semver@7.8.5 | ISC |
| send@1.2.1 | MIT |
| serve-static@2.2.1 | MIT |
| setimmediate@1.0.5 | MIT |
| setprototypeof@1.2.0 | ISC |
| shebang-command@2.0.0 | MIT |
| shebang-regex@3.0.0 | MIT |
| side-channel-list@1.0.1 | MIT |
| side-channel-map@1.0.1 | MIT |
| side-channel-weakmap@1.0.2 | MIT |
| side-channel@1.1.1 | MIT |
| simple-concat@1.0.1 | MIT |
| simple-get@4.0.1 | MIT |
| sprintf-js@1.0.3 | BSD-3-Clause |
| statuses@2.0.2 | MIT |
| string_decoder@1.1.1 | MIT |
| string_decoder@1.3.0 | MIT |
| strip-json-comments@2.0.1 | MIT |
| tar-fs@2.1.5 | MIT |
| tar-stream@2.2.0 | MIT |
| tmp@0.2.7 | MIT |
| toidentifier@1.0.1 | MIT |
| traverse@0.3.9 | MIT* |
| tunnel-agent@0.6.0 | Apache-2.0 |
| type-is@2.1.0 | MIT |
| underscore@1.13.8 | MIT |
| undici@7.29.0 | MIT |
| unpipe@1.0.0 | MIT |
| unzipper@0.10.14 | MIT |
| util-deprecate@1.0.2 | MIT |
| uuid@8.3.2 | MIT |
| vary@1.1.2 | MIT |
| whatwg-encoding@3.1.1 | MIT |
| whatwg-mimetype@4.0.0 | MIT |
| which@2.0.2 | ISC |
| wrappy@1.0.2 | ISC |
| xmlbuilder@10.1.1 | MIT |
| xmlchars@2.2.0 | MIT |
| zip-stream@4.1.1 | MIT |
| zod-to-json-schema@3.25.2 | ISC |
| zod@4.4.3 | MIT |
