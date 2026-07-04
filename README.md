# DeepSeek Usage Tracker

VSCode 插件 — 实时查看 DeepSeek API 余额与用量统计。

## 功能

- 底栏右侧显示当月消费 / 总余额
- Dashboard 面板：余额卡片、按模型 Token 明细、每日用量趋势
- 支持中英文切换
- 支持代理（国内用户走梯子）
- 每 5 分钟自动刷新

## 配置

| 配置项 | 说明 | 必填 |
|--------|------|------|
| `deepseek-usage.apiKey` | API Key (sk-...)，用于查询余额 | 是 |
| `deepseek-usage.sessionToken` | 平台 Session Token (Bearer ...)，用于查询用量 | 是（用量） |
| `deepseek-usage.cookie` | 浏览器 Cookie，和 Session Token 配合使用 | 是（用量） |
| `deepseek-usage.proxy` | HTTP 代理地址，如 `http://127.0.0.1:7890` | 否 |
| `deepseek-usage.language` | 显示语言：`en` / `zh-cn` | 否 |

### 如何获取 Session Token 和 Cookie

1. 浏览器登录 [platform.deepseek.com](https://platform.deepseek.com)
2. 进入 Usage 页面
3. F12 → Network → 找到 `amount` 或 `cost` 请求
4. 复制 `Authorization` 头中的 `Bearer xxx` → 填入 `sessionToken`
5. 复制 `Cookie` 请求头 → 填入 `cookie`

## 开发

```bash
# 安装依赖
npm install

# 按 F5 启动 Extension Development Host
# 或命令行：
code --extensionDevelopmentPath=.

# 打包
npx vsce package
```

## License

MIT
