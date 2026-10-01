# 0KAY · Our Free Model

opencode Zen 免费车道（MiMo V2.6、Muse Spark 1.3 …）作为 0KAY provider。无需账号、无需 API Key。

**由 Core 以 stdio 子进程承载 —— 不监听任何端口。** manifest 声明 `provider.stdio`，
Core 启动时拉起本插件、通过逐行 JSON 在 stdin/stdout 上转发 OpenAI 请求，并注册 provider
（模型列表由 Core 调本插件的 `/v1/models` 动态发现）。

## manifest

```json
"provider": {
  "id": "opencode-free",
  "name": "Our Free Model",
  "route": "/v1",
  "stdio": ["node", "src/stdio.mjs"]
}
```

安装后**重启 Core** 即生效（Core 只在启动时拉起 stdio provider）。

## 调试

```bash
node src/stdio.mjs                                  # Core 使用的 stdio 模式
printf '{"id":"t","method":"GET","url":"/v1/models"}\n' | node src/stdio.mjs
node src/server.mjs                                 # 可选：本地 HTTP 模式（监听 127.0.0.1:8791）
npm test
```

配置：`FREE_MODEL_MAX_TOKENS`（默认 32768）、`FREE_MODEL_REFRESH_MS` 等环境变量沿用。
