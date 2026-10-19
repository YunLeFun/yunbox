import Foundation

/// One line of one side of a split diff.
public struct DiffCell: Sendable, Equatable {
    /// Line number in that version, starting at 1.
    public let number: Int
    public let text: String
    /// Removed (left) or added (right); `false` for context.
    public let changed: Bool

    public init(number: Int, text: String, changed: Bool) {
        self.number = number
        self.text = text
        self.changed = changed
    }
}

/// A row of a side-by-side diff: before on the left, after on the right.
public enum SplitDiffRow: Sendable, Equatable {
    /// `@@ -a,b +c,d @@` and the function context Git prints after it.
    case hunk(String)
    /// `\ No newline at end of file`.
    case note(String)
    /// A side is `nil` where the other version has a line with no counterpart.
    case lines(left: DiffCell?, right: DiffCell?)
}

/// Side-by-side rows and line counts of a unified diff (`git diff` output from the first hunk on).
public struct SplitDiff: Sendable, Equatable {
    public let rows: [SplitDiffRow]
    public let added: Int
    public let removed: Int

    /// Context lines appear on both sides; a block of removed lines and the added block after it
    /// are paired line by line, the longer block's extra lines facing an empty cell.
    public init(unified text: String) {
        var rows: [SplitDiffRow] = []
        var removedBlock: [DiffCell] = []
        var addedBlock: [DiffCell] = []
        var old = 1
        var new = 1
        var added = 0
        var removed = 0
        func flush() {
            for index in 0..<max(removedBlock.count, addedBlock.count) {
                rows.append(.lines(left: removedBlock.indices.contains(index) ? removedBlock[index] : nil,
                                   right: addedBlock.indices.contains(index) ? addedBlock[index] : nil))
            }
            removedBlock = []
            addedBlock = []
        }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let content = String(line.dropFirst())
            switch line.first {
            case "@":
                flush()
                if let match = line.firstMatch(of: /^@@ -(\d+)(?:,\d+)? \+(\d+)/) {
                    old = Int(match.1) ?? 1
                    new = Int(match.2) ?? 1
                }
                rows.append(.hunk(String(line)))
            case "-":
                removedBlock.append(DiffCell(number: old, text: content, changed: true))
                old += 1
                removed += 1
            case "+":
                addedBlock.append(DiffCell(number: new, text: content, changed: true))
                new += 1
                added += 1
            case "\\":
                flush()
                rows.append(.note(String(line)))
            case " ":
                flush()
                rows.append(.lines(left: DiffCell(number: old, text: content, changed: false),
                                   right: DiffCell(number: new, text: content, changed: false)))
                old += 1
                new += 1
            default:
                // Only the empty string after the final newline.
                continue
            }
        }
        flush()
        self.rows = rows
        self.added = added
        self.removed = removed
    }
}
