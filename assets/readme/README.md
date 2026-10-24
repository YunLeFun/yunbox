# README 宣传素材 / README promotional assets

这组主图用于 GitHub README、项目介绍和分享卡片，是宣传插画，不是产品截图。两张图均为 1672 × 941 WebP，约 16:9；尺寸保持不变。

These banners are promotional illustrations for GitHub READMEs, project introductions and share cards, not app screenshots. Both are 1672 × 941 WebP images, approximately 16:9, with the original dimensions preserved.

| 文件 / File | 用途 / Use |
| --- | --- |
| [hero-zh.webp](./hero-zh.webp) | 中文 README / Chinese README |
| [hero-en.webp](./hero-en.webp) | 英文 README / English README |

README 中的真实界面复用 [亮色截图](../../docs/guide/images/macos-asset-types-light.jpg) 和 [深色截图](../../docs/guide/images/macos-asset-types-dark.jpg)，保持原始内容。品牌源文件仍以 [assets/brand](../brand/) 为准。

The READMEs reuse the original [light](../../docs/guide/images/macos-asset-types-light.jpg) and [dark](../../docs/guide/images/macos-asset-types-dark.jpg) app screenshots without edits. Canonical brand artwork remains in [assets/brand](../brand/).

## WebP 压缩 / WebP compression

| 主图 / Banner | 原始 PNG / Original PNG | WebP | 缩减 / Reduction |
| --- | ---: | ---: | ---: |
| 中文 / Chinese | 1,711,552 B | 128,390 B (125.4 KiB) | 92.50% |
| 英文 / English | 1,646,127 B | 118,680 B (115.9 KiB) | 92.79% |
| 合计 / Total | 3,357,679 B | 247,070 B (241.3 KiB) | 92.64% |

使用 `cwebp` 编码，质量 90、保留原始尺寸，检查中英文文字清晰度后采用 WebP。仓库只保留 WebP；原始 PNG 保留在生成工具的本机输出目录。

Encoded with `cwebp` at quality 90, preserving dimensions. Both languages were visually checked for readable text. Only WebP files are included in the repository; original PNGs remain in the generator's local output directory.

从原始 PNG 重新编码 / Re-encode from an original PNG:

```bash
cwebp -q 90 -m 6 -sharp_yuv -metadata none input.png -o output.webp
```

## 生成记录 / Generation record

- 日期 / Date: 2026-10-24
- 工具 / Tool: built-in `image_gen`，未使用 CLI/API 回退 / no CLI/API fallback.
- 中文图从文字生成；英文图以中文图为参考，仅本地化文案 / Chinese banner generated from text; English banner localized from the Chinese banner.
- 两张成品都已检查文字和排版；下方保留最终提示词 / Both outputs were checked for text and layout; final prompts are recorded below.
- 生成结果以实际尺寸为准；提示词中的尺寸为目标值 / Actual output dimensions take precedence over the requested size in the prompt.

### 中文主图 / Chinese banner

```text
Use case: ads-marketing
Asset type: Chinese GitHub README hero and social promotional illustration, landscape 16:9, 1536x864.
Primary request: Create an elegant editorial promotional banner for 云匣 YunBox, an open-source Git LFS asset hosting and push inspection tool. Existing brand uses cobalt blue #2563eb and the idea of a simple storage box. This is an illustration, not a screenshot or new logo design.
Scene/backdrop: warm near-white background with extremely subtle blue ambient shadows, generous whitespace, clean premium software aesthetic.
Subject: on the right half, a beautifully crafted matte cobalt-blue storage box, open lid gently floating above it, with a subtle triangular opening and circular opening on its front referencing the brand. A small number of floating asset cards rise from the box: a landscape photograph thumbnail, a 3D geometric model, an audio waveform, a small filmstrip. Thin softly curved blue lines suggest assets flowing to a small cloud shape; a discreet branch/commit glyph suggests Git. Balanced tactile 3D illustration, precise geometry and soft studio lighting.
Composition/framing: left 47% reserved for very large typography; right 53% illustration, balanced and uncluttered. Keep all content within generous 7% safe margins.
Text (verbatim), left-aligned, using beautifully typeset modern sans-serif Chinese:
small eyebrow "GIT LFS · 开源素材托管"
large title "云匣 YunBox"
two-line main tagline "代码交给 Git，" and "素材交给云匣。"
small supporting line "自己的存储 · 熟悉的 Git 工作流"
small footer "yunbox.yunle.fun"
Constraints: All text must be exact and legible, dark navy. Use cobalt blue highlights. No fake interface, no code snippets, no extra text, no third-party logos, no badges claiming certifications, no watermarks, no purple gradients, no glowing neon, no clutter.
```

### 英文本地化 / English localization

输入是中文主图的原始 PNG；压缩版见 [hero-zh.webp](./hero-zh.webp)。

Input was the original Chinese PNG; see [hero-zh.webp](./hero-zh.webp) for its compressed version.

```text
Use case: text-localization
Asset type: English GitHub README hero and social promotional illustration, same 16:9 landscape dimensions as reference.
Input image: edit target, the finished Chinese YunBox banner.
Primary request: Make an English localization. Preserve the right-half 3D blue box, floating asset cards, cloud and Git branch symbol, lighting, palette, background, materials and margins exactly. Change ONLY the left-side typography to the exact English text below. Retain the same hierarchy; adjust font sizes as needed so English text is comfortably readable and fully fits in the left half with no overlap.
Text (verbatim):
small eyebrow "GIT LFS · OPEN SOURCE"
large title "YunBox"
two-line main tagline "Code stays in Git." and "Assets live in YunBox."
small supporting line, can wrap if needed: "Your storage. Your Git workflow."
small footer "yunbox.yunle.fun"
Constraints: Match the existing navy and cobalt colors and modern sans-serif typography. No Chinese characters in the output. Do not add text, UI, logos or watermarks. Preserve the illustration without any changes.
```
