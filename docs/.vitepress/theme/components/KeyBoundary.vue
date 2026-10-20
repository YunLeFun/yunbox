<script setup lang="ts">
/**
 * What is committed and shared versus what never leaves a member's
 * machine, shown as the actual files, followed by the storage guarantees.
 */
import { useCopy } from '../i18n'
import SymbolIcon from './SymbolIcon.vue'

/** Icons for the facts below, in the same order. */
const FACT_ICONS = ['lock', 'doc.on.doc', 'checkmark.shield', 'key'] as const

const t = useCopy({
  zh: {
    shared: '提交进仓库，全组共享',
    sharedNote: '只记录素材放在哪里，没有任何密钥。不同项目可以用不同 bucket，也可以共用一个 bucket、各用一个前缀。',
    local: '只在你自己的电脑上',
    keychain: 'macOS 钥匙串（yunbox）',
    localNote: ['每人一个子账号，只能读写这个前缀。有人离开项目，', ' 之后对方的密钥立即失效。Linux 和 Windows 上密钥存在只有本人可读的文件里。'],
    facts: [
      { title: '不覆盖', body: '上传带 x-cos-forbid-overwrite，已经存在的对象不会被改写。' },
      { title: '只传一次', body: '对象按 SHA-256 内容寻址，同样的文件全组只上传一次。' },
      { title: '下载校验', body: '核对大小和 SHA-256，被替换或损坏的对象不会交给 git-lfs。' },
      { title: '最小权限', body: '子账号只有这个前缀的读写，不能列出 bucket，也不能删除。' },
    ],
  },
  en: {
    shared: 'Committed and shared with the team',
    sharedNote: 'Only where the assets live, never a key. Each project can have its own bucket, or several can share one bucket with a prefix each.',
    local: 'Only on your own computer',
    keychain: 'macOS Keychain (yunbox)',
    localNote: ['Everyone gets a sub-account that can only read and write this prefix. When someone leaves, ', ' revokes their key at once. On Linux and Windows the key lives in a file only you can read.'],
    facts: [
      { title: 'Never overwrites', body: 'Uploads carry x-cos-forbid-overwrite, so an existing object is never replaced.' },
      { title: 'Uploaded once', body: 'Objects are addressed by SHA-256, so the same file is uploaded once for the whole team.' },
      { title: 'Verified downloads', body: 'Size and SHA-256 are checked; a swapped or corrupted object never reaches git-lfs.' },
      { title: 'Least privilege', body: 'Sub-accounts can read and write this prefix only. They cannot list the bucket or delete anything.' },
    ],
  },
})
</script>

<template>
  <div class="boundary">
    <section class="side">
      <p class="side-title">
        <span class="tile tile-grey"><SymbolIcon name="arrow.triangle.branch" /></span>
        {{ t.shared }}
      </p>
      <p class="file-name">
        .yunbox/config
      </p>
      <pre class="file"><code>[cos]
    bucket = team-assets-1250000000
    region = ap-shanghai
    prefix = yunbox/team/game</code></pre>
      <p class="file-name">
        .gitattributes
      </p>
      <pre class="file"><code>*.psd filter=lfs diff=lfs merge=lfs -text
*.fbx filter=lfs diff=lfs merge=lfs -text
*.wav filter=lfs diff=lfs merge=lfs -text</code></pre>
      <p class="side-note">
        {{ t.sharedNote }}
      </p>
    </section>

    <section class="side">
      <p class="side-title">
        <span class="tile"><SymbolIcon name="key" /></span>
        {{ t.local }}
      </p>
      <p class="file-name">
        {{ t.keychain }}
      </p>
      <pre class="file"><code>SecretId   AKID••••••••••••••••
SecretKey  ••••••••••••••••••••</code></pre>
      <p class="file-name">
        .git/config
      </p>
      <pre class="file"><code>[lfs]
    standalonetransferagent = yunbox
    locksverify = false</code></pre>
      <p class="side-note">
        {{ t.localNote[0] }}<code>yunbox subaccount delete</code>{{ t.localNote[1] }}
      </p>
    </section>
  </div>

  <dl class="facts">
    <div v-for="(fact, index) in t.facts" :key="FACT_ICONS[index]">
      <dt>
        <SymbolIcon :name="FACT_ICONS[index]" class="fact-icon" />
        {{ fact.title }}
      </dt>
      <dd>{{ fact.body }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.boundary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 22px 24px;
  border-radius: var(--yb-radius-panel);
  background: var(--yb-window);
  box-shadow: 0 0 0 0.5px var(--yb-separator), 0 2px 8px -2px rgb(0 0 0 / 0.08);
}

.side-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 6px;
  color: var(--yb-label);
  font-weight: 600;
  font-size: 17px;
}

.tile {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: linear-gradient(#55aaff, #2563eb);
  color: #fff;
  font-size: 17px;
}

.tile-grey {
  background: linear-gradient(#8e8e93, #636366);
}

.file-name {
  margin: 8px 0 0;
  color: var(--yb-label-2);
  font-size: 12.5px;
  font-weight: 500;
}

.file {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--yb-code-bg);
  box-shadow: inset 0 0 0 0.5px var(--yb-separator);
  color: var(--yb-label);
  font-family: var(--yb-font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  overflow-x: auto;
}

.side-note {
  margin: 10px 0 0;
  color: var(--yb-label-2);
  font-size: 14px;
  line-height: 1.7;
}

.side-note code {
  padding: 0;
  background: none;
  color: var(--yb-label);
  font-family: var(--yb-font-mono);
  font-size: 0.9em;
}

.facts {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 28px;
  margin: 40px 0 0;
}

.facts dt {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--yb-label);
  font-weight: 600;
}

.fact-icon {
  color: var(--yb-accent);
  font-size: 19px;
}

.facts dd {
  margin: 0;
  color: var(--yb-label-2);
  font-size: 14px;
  line-height: 1.7;
}

@media (max-width: 860px) {
  .boundary {
    grid-template-columns: 1fr;
  }

  .facts {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 520px) {
  .side {
    padding: 18px;
  }

  .facts {
    grid-template-columns: 1fr;
    gap: 20px;
  }
}
</style>
