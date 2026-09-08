import SwiftUI

struct ContentView: View {
    @ObservedObject private var quickPhotoRouter = QuickPhotoInboxRouter.shared

    var body: some View {
        SecretaryChatRootView()
            .onOpenURL { quickPhotoRouter.handle(url: $0) }
            .task {
#if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-InfansQuickCaptureFixture")
                    || ProcessInfo.processInfo.arguments.contains("InfansQuickCaptureFixture")
                    || ProcessInfo.processInfo.environment["INFANS_QUICK_CAPTURE_FIXTURE"] == "1" {
                    quickPhotoRouter.open()
                }
#endif
            }
            .fullScreenCover(isPresented: $quickPhotoRouter.isPresented, onDismiss: quickPhotoRouter.close) {
                QuickPhotoInboxView()
            }
    }
}
