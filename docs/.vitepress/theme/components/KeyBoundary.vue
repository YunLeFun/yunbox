<script setup lang="ts">
/**
 * What is committed and shared versus what never leaves a member's machine,
 * shown as the actual files.
 */
</script>

<template>
  <div class="boundary">
    <div class="side">
      <p class="side-title">
        提交进仓库，全组共享
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
        只记录素材放在哪里，没有任何密钥。不同项目可以用不同 bucket，也可以共用一个 bucket、各用一个前缀。
      </p>
    </div>

    <div class="side side-private">
      <p class="side-title">
        只在你自己的电脑上
      </p>
      <p class="file-name">
        macOS 钥匙串（yunbox）
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
        每人一个子账号，只能读写这个前缀。有人离开项目，<code>yunbox subaccount delete</code> 之后对方的密钥立即失效。Linux 和 Windows 上密钥存在只有本人可读的文件里。
      </p>
    </div>
  </div>

  <dl class="facts">
    <div>
      <dt>不覆盖</dt>
      <dd>上传带 <code>x-cos-forbid-overwrite</code>，已经存在的对象不会被改写。</dd>
    </div>
    <div>
      <dt>只传一次</dt>
      <dd>对象按 SHA-256 内容寻址，同样的文件全组只上传一次。</dd>
    </div>
    <div>
      <dt>下载校验</dt>
      <dd>核对大小和 SHA-256，被替换或损坏的对象不会交给 git-lfs。</dd>
    </div>
    <div>
      <dt>最小权限</dt>
      <dd>子账号只有这个前缀的读写，不能列出 bucket，也不能删除。</dd>
    </div>
  </dl>
</template>

<style scoped>
.boundary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1.5px solid var(--yb-ink);
  border-radius: var(--yb-radius-lg);
  overflow: hidden;
  background: var(--yb-sheet);
}

.side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 24px;
  min-width: 0;
}

.side-private {
  border-left: 1.5px dashed var(--yb-ink);
  background: var(--yb-paper);
}

.side-title {
  margin: 0 0 6px;
  color: var(--yb-ink);
  font-weight: 700;
  font-size: 17px;
}

.file-name {
  margin: 8px 0 0;
  color: var(--yb-ink-soft);
  font-size: 13px;
}

.file {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--yb-radius-sm);
  background: var(--yb-term-bg);
  color: var(--yb-term-ink);
  font-family: var(--yb-font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  tab-size: 4;
  overflow-x: auto;
}

.side-note {
  margin: 10px 0 0;
  color: var(--yb-ink-soft);
  font-size: 14px;
  line-height: 1.7;
}

.side-note code,
.facts code {
  font-family: var(--yb-font-mono);
  font-size: 0.9em;
  color: var(--yb-ink);
}

.facts {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 24px;
  margin: 32px 0 0;
}

.facts dt {
  color: var(--yb-ink);
  font-weight: 700;
  margin-bottom: 4px;
}

.facts dd {
  margin: 0;
  color: var(--yb-ink-soft);
  font-size: 14px;
  line-height: 1.7;
}

@media (max-width: 860px) {
  .boundary {
    grid-template-columns: 1fr;
  }

  .side-private {
    border-left: 0;
    border-top: 1.5px dashed var(--yb-ink);
  }

  .facts {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 520px) {
  .facts {
    grid-template-columns: 1fr;
  }
}
</style>
