import process from 'node:process'

/** How to install or upgrade Git on this platform. */
export function gitInstallHints(platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case 'darwin':
      return ['brew install git', '或运行 xcode-select --install']
    case 'win32':
      return ['从 https://git-scm.com/download/win 安装 Git for Windows']
    default:
      return ['sudo apt-get install git   # Debian / Ubuntu，其他发行版用对应的包管理器']
  }
}

/** How to install or upgrade git-lfs on this platform. */
export function gitLfsInstallHints(platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case 'darwin':
      return ['brew install git-lfs', 'git lfs install']
    case 'win32':
      return ['升级 Git for Windows（自带 git-lfs），或从 https://git-lfs.com 安装', 'git lfs install']
    default:
      return [
        'sudo apt-get install git-lfs   # 发行版自带的版本太旧时，按 https://git-lfs.com 的说明安装',
        'git lfs install',
      ]
  }
}
