import Foundation

enum SecretaryBundledArt {
    static let openSourceSeatIDs = ["yinyue", "meining"]

    static func seatIDs() -> [String] {
        openSourceSeatIDs
    }

    static func resolvedSeatID(_ raw: String?) -> String {
        if let raw, openSourceSeatIDs.contains(raw) { return raw }
        return "yinyue"
    }

    static func backgroundAssetName(for secretaryID: String?, landscape: Bool) -> String {
        switch resolvedSeatID(secretaryID) {
        case "meining":
            // iPad 横屏用 梅凝_背景图_iPad横屏裁切_01.png；人物留在聊天框右侧。
            return landscape ? "MeiningChatBackgroundLandscape" : "MeiningChatBackgroundPortrait"
        default:
            // iPad 横屏用 银月_背景图_iPad横屏裁切_01.png；人物留在聊天框右侧。
            return landscape ? "YinyueChatBackgroundLandscape" : "YinyueChatBackgroundPortrait"
        }
    }

    static func avatarAssetName(for secretaryID: String?) -> String {
        switch resolvedSeatID(secretaryID) {
        case "meining": return "MeiningSeatAvatar"
        default: return "YinyueSeatAvatar"
        }
    }

    static func seats(merging remote: [SecretaryChatCharacter] = []) -> [SecretaryChatCharacter] {
        seatIDs().map { id in
            remote.first(where: { $0.id == id }) ?? bundledCharacter(id: id)
        }
    }

    static func bundledCharacter(id: String) -> SecretaryChatCharacter {
        switch resolvedSeatID(id) {
        case "meining":
            return SecretaryChatCharacter(
                id: "meining",
                displayName: "梅凝",
                kind: "secretary",
                secretaryEligible: true,
                fallbackText: "梅凝",
                accent: "plum",
                assets: SecretaryChatCharacterAssets(avatar: nil, portrait: nil, source: "bundled", mediaMode: nil, manifestPath: nil)
            )
        default:
            return SecretaryChatCharacter(
                id: "yinyue",
                displayName: "银月",
                kind: "secretary",
                secretaryEligible: true,
                fallbackText: "银月",
                accent: "jade",
                assets: SecretaryChatCharacterAssets(avatar: nil, portrait: nil, source: "bundled", mediaMode: nil, manifestPath: nil)
            )
        }
    }
}
