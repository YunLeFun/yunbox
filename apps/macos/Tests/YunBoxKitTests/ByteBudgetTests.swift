import Foundation
import Testing
@testable import YunBoxKit

@Test func parsesSizesTheWayTheCLIDoes() {
    #expect(ByteBudget(parsing: "900k") == ByteBudget(900, .kib))
    #expect(ByteBudget(parsing: "100MiB") == ByteBudget(100, .mib))
    #expect(ByteBudget(parsing: " 2G ") == ByteBudget(2, .gib))
    #expect(ByteBudget(parsing: "512") == ByteBudget(512, .bytes))
    #expect(ByteBudget(parsing: "512b") == ByteBudget(512, .bytes))
    for invalid in ["", "k", "1.5m", "-1k", "10 m", "10mb", "１０m", "9007199254740991"] {
        #expect(ByteBudget(parsing: invalid) == nil, "\(invalid)")
    }
}

@Test func formatsForSettingsAndDisplay() {
    let budget = ByteBudget(900, .kib)
    #expect(budget.argument == "900k")
    #expect(budget.bytes == 921_600)
    #expect(budget.label == "900 KiB")
    #expect(ByteBudget(512, .bytes).argument == "512")
    #expect(ByteBudget(clamping: -3, .mib) == ByteBudget(0, .mib))
    #expect(ByteBudget(clamping: .max, .gib).bytes <= ByteBudget.maxBytes)
}

@Test func buildsCLIArgumentsFromSettings() throws {
    let defaults = try #require(UserDefaults(suiteName: "ByteBudgetTests"))
    defer { defaults.removePersistentDomain(forName: "ByteBudgetTests") }
    defaults.set("2m", forKey: BudgetSetting.git.key)
    defaults.set("1.5m", forKey: BudgetSetting.lfs.key)
    #expect(BudgetSetting.arguments(in: defaults, overriding: false).isEmpty)
    #expect(BudgetSetting.arguments(in: defaults, overriding: true)
        == ["--git-limit", "2m", "--lfs-limit", "100m", "--file-limit", "10m"])
    #expect(BudgetSetting.allCases.allSatisfy { $0.presets.contains($0.defaultValue) })
}
