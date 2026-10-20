import SwiftUI

extension View {
    /// For a `ScrollView` in a sheet padded by `inset`: reach out to the sheet's edges so the scroller sits in the
    /// margin instead of over the content, and keep the content where the rest of the sheet lines up.
    func sheetScrollMargins(_ inset: CGFloat = 24) -> some View {
        contentMargins(.horizontal, inset, for: .scrollContent)
            .padding(.horizontal, -inset)
    }
}
