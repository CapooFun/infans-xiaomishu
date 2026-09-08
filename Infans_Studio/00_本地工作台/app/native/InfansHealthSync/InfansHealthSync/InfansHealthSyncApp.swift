import BackgroundTasks
import AppIntents
import SwiftUI
import UserNotifications

final class HealthSyncAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        let healthTaskRegistered = BGTaskScheduler.shared.register(forTaskWithIdentifier: HealthSyncSchedule.taskIdentifier, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            let work = Task { @MainActor in
                let success = await SyncCoordinator.shared.performBackgroundSync()
                refreshTask.setTaskCompleted(success: success)
            }
            refreshTask.expirationHandler = {
                work.cancel()
                Task { @MainActor in SyncCoordinator.shared.recordBackgroundTaskExpiration() }
            }
        }
        if !healthTaskRegistered {
            SyncCoordinator.shared.settings.recordBackgroundAttempt(
                trigger: .backgroundRefresh,
                text: "后台任务处理器注册失败"
            )
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: InboxIntakeRetrySchedule.taskIdentifier, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            let work = Task { @MainActor in
                let success = await YingningIntakeCoordinator.shared.retryPending()
                refreshTask.setTaskCompleted(success: success)
            }
            refreshTask.expirationHandler = { work.cancel() }
        }
        SyncCoordinator.shared.configureBackgroundServices(refreshStatus: application.backgroundRefreshStatus)
        PhoneCommandBridge.shared.start()
        YingningIntakeCoordinator.shared.start()
        Task { @MainActor in ForegroundScreenshotInboxCapture.shared.start() }
        if (launchOptions?[.shortcutItem] as? UIApplicationShortcutItem)?.type == "com.example.infans.secretary.quick-photo" {
            Task { @MainActor in QuickPhotoInboxRouter.shared.open() }
        }
        return true
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let conversationID = response.notification.request.content.userInfo["conversationId"] as? String
        Task { @MainActor in
            SecretaryChatNotificationRouter.shared.receive(conversationID: conversationID)
            completionHandler()
        }
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        SyncCoordinator.shared.recordBackgroundRefreshStatus(application.backgroundRefreshStatus)
        SyncCoordinator.shared.scheduleNextBackgroundRefresh()
        InboxIntakeRetrySchedule.submit()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        PhoneCommandBridge.shared.prepareBackgroundCredential()
        SyncCoordinator.shared.recordBackgroundRefreshStatus(application.backgroundRefreshStatus)
        if application.backgroundRefreshStatus == .available {
            SyncCoordinator.shared.scheduleNextBackgroundRefresh()
        }
        SyncCoordinator.shared.syncForegroundIfDue()
        Task { @MainActor in _ = await YingningIntakeCoordinator.shared.retryPending() }
    }

    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        guard shortcutItem.type == "com.example.infans.secretary.quick-photo" else { completionHandler(false); return }
        QuickPhotoInboxRouter.shared.open()
        completionHandler(true)
    }

    func applicationProtectedDataDidBecomeAvailable(_ application: UIApplication) {
        PhoneCommandBridge.shared.prepareBackgroundCredential()
    }
}

@main
struct InfansHealthSyncApp: App {
    @UIApplicationDelegateAdaptor(HealthSyncAppDelegate.self) private var appDelegate

    init() {
        InfansSecretaryAppShortcuts.updateAppShortcutParameters()
        Task { try? await IntentDonationManager.shared.donate(intent: OpenQuickPhotoInboxIntent()) }
#if DEBUG
        let process = ProcessInfo.processInfo
        if process.arguments.contains("InfansQuickCaptureFixture")
            || process.arguments.contains("-InfansQuickCaptureFixture")
            || process.environment["INFANS_QUICK_CAPTURE_FIXTURE"] == "1" {
            SecretarySharedConfiguration.defaults.set(Date().timeIntervalSince1970, forKey: "secretary.quickPhoto.fixtureBootAt")
            Task { @MainActor in
                let model = QuickPhotoInboxModel()
                await model.start()
                try? await Task.sleep(for: .seconds(2))
            }
        } else if process.arguments.contains("InfansQuickCaptureCleanup") {
            Task {
                await InboxIntakeDeliveryService().removeQuickPhotoFixtures()
                let defaults = SecretarySharedConfiguration.defaults
                for key in [
                    "secretary.quickPhoto.debugSavedFileExists",
                    "secretary.quickPhoto.debugStorePath",
                    "secretary.quickPhoto.fixtureBootAt",
                    "secretary.quickPhoto.lastSavedAt",
                    "secretary.quickPhoto.lastSavedItemID"
                ] { defaults.removeObject(forKey: key) }
            }
        }
#endif
    }

    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
