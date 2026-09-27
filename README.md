# Our Free Model for 0KAY

A 0KAY plugin that exposes the public [opencode Zen](https://opencode.ai) free
model lane — MiMo V2.6, Muse Spark 1.3, Nemotron, Ling, Space Bunny and the rest
— to 0KAY as an ordinary provider. **No account, no sign-up, no API key.**

It is a port of [zouyuxuan122/dsh-our-free-model](https://github.com/zouyuxuan122/dsh-our-free-model)
(MIT), re-shaped as a standalone 0KAY service plugin.

## How it works

0KAY providers cannot send custom HTTP headers, and this lane fingerprints the
client by its headers (`Authorization: Bearer public`, `x-opencode-*`,
`User-Agent: opencode/…`). So the plugin runs a small **loopback OpenAI-compatible
adapter** and points a provider at it:

```
0KAY Core → MOCR → http://127.0.0.1:8791/v1  →  opencode Zen free lane
                    (this plugin)                (chat / responses / messages)
```

The adapter translates an OpenAI chat request into whichever wire the chosen
model answers on (`/chat/completions`, `/responses` or `/messages`) and streams
the reply back as OpenAI chat deltas, so 0KAY never sees the difference. On start
it registers the *Our Free Model* provider with Core automatically.

## Install

```sh
# from the published repository
0kay-pm install razureink/0KAY-free-model

# or from a local checkout of this repository
0kay-pm install --source . razureink/0KAY-free-model
```

Then open 0KAY → Settings → Providers: **Our Free Model** appears with the free
models, and they show up in the chat model picker. (No pairing is required;
`--no-pair` skips the interactive prompt.)

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `FREE_MODEL_PORT` | `8791` | Loopback port for the adapter |
| `FREE_MODEL_HOST` | `127.0.0.1` | Bind address (loopback only by design) |
| `FREE_MODEL_KEY` | generated | Local adapter API key (else `data/free-model/key`) |
| `FREE_MODEL_MAX_TOKENS` | `32768` | Default output ceiling |
| `FREE_MODEL_REFRESH_MS` | `1800000` | Model-catalog refresh interval |
| `OUR_FREE_MODEL_BASE` | `https://opencode.ai` | Upstream (tests only) |
| `FREE_MODEL_CORE_HTTP` | `CORE_HTTP_ADDR` / `http://127.0.0.1:8080` | Core URL for registration |

## Notes

- The adapter binds to loopback and requires the local key on every model route;
  `/` and `/health` are liveness-only.
- "Free" means no billing and no per-token charge, but the lane rate-limits per
  session; the adapter keeps one session per conversation so retries don't burn
  quota.
- This is an independent plugin and is not affiliated with or endorsed by any
  model provider. Using the free lane is subject to the provider's terms, and the
  lane can change or disappear at any time.
- `npm test` runs the unit tests (routing, headers, fingerprint, shaping, budget,
  stream projection).
