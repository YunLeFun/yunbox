import SwiftUI
import YunBoxKit

/// What a setup command printed and whether it succeeded, with the CLI's step marks coloured like the doctor list.
struct CommandOutputView: View {
    let output: CommandOutput

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(output.succeeded ? "已完成" : "未完成（退出码 \(output.exitCode)）",
                  systemImage: output.succeeded ? "checkmark.circle" : "xmark.octagon")
                .foregroundStyle(output.succeeded ? .green : .orange)
            // One Text, so a selection can span lines.
            Text(Self.styled(output)).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
        }
    }

    static func styled(_ output: CommandOutput) -> AttributedString {
        var result = AttributedString()
        for (index, line) in output.lines.enumerated() {
            if index > 0 { result += AttributedString("\n") }
            if let mark = line.mark {
                var marker = AttributedString(line.marker)
                marker.foregroundColor = tint(mark)
                marker.font = .system(.caption, design: .monospaced).bold()
                result += marker
            }
            result += AttributedString(line.body)
        }
        return result
    }

    private static func tint(_ mark: CommandOutput.Mark) -> Color {
        switch mark {
        case .pass: .green
        case .warn: .orange
        case .fail, .error: .red
        case .skip: .secondary
        }
    }
}
