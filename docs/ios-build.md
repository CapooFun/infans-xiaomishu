# iPhone／iPad 从空工程自己签证

开源提供一对一原生客户端架构和银月／梅凝基础图，**不是**已经签好的安装包。对方要自己申请苹果开发者账号、自己填 Team／Bundle／App Group、自己签名、自己配对。仓库里的 example 标识只是空位。

## 工程位置

`Infans_Studio/00_本地工作台/app/native/InfansHealthSync/InfansHealthSync.xcodeproj`

主 App 与系统分享扩展都在这个工程里。Mac 桌面壳是另一条源码路线，见 `macos-build.md`。

## 空位（必须换成你自己的）

打开 Xcode 后，把 Signing & Capabilities 里的值改成你账号下的标识。仓库默认只允许这类 example，Team 为空：

| 项 | 仓库空位 | 你要改成 |
|---|---|---|
| Team | 空 | 你的 Apple Developer Team |
| App Bundle ID | `com.example.infans.secretary` | 你自己申请的 ID |
| Share Bundle ID | `com.example.infans.secretary.share` | 同上，单独一条 |
| App Group | `group.com.example.infans.secretary` | 你自己的 App Group，主 App 与分享扩展一致 |

`Info.plist` 里的 `InfansProductEdition` 应为 `opensource`。不要把别人的 Team ID、描述文件或证书拷进来「为了先能装上」。

若磁盘上还能看到非 example 的 Bundle ID 或别人的 Team 号，先改成你自己的，再编译。

## 建议顺序

1. 用 Xcode 打开上面的工程，选 **iPhone 模拟器**。
2. 选中 InfansHealthSync target，打开 Signing，勾选 Automatically manage signing，填入你的 Team。
3. 把 Bundle ID、分享扩展 Bundle ID、App Group、钥匙串组改成上表「你要改成」的值，并保持 entitlements 与 Xcode 能力面板一致。
4. 分享扩展必须与主 App 使用同一个 App Group，否则来件队列对不上。
5. 先在模拟器编过、装上、打开一对一聊天。真机还要在开发者后台启用 HealthKit、App Group 等你实际用到的能力。
6. 工作台地址、信箱 URL 和设备令牌填你自己的。没有别人机器的默认主机。

网页工作台仍按 `quickstart.md` 在本机 `127.0.0.1:5173` 跑。手机原生负责一对一聊天，以及把系统分享送进你配置的信箱。
