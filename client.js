window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Services this half reads. `remote.commands` is the only channel to the Host. */
    const inject = ['slots', 'remote', 'remote.commands', 'uiWorkspace']

    /** A stable empty snapshot: useSyncExternalStore needs identity stability. */
    const EMPTY_SESSIONS = { ids: [], byId: {} }

    const T = {
      trigger: '记忆归档',
      title: '记忆归档设置',
      hint: '调整打包节奏。改动写入配置，重启 DSH 后生效。',
      mode: '打包模式',
      modeManual: '按轮数',
      modeSync: '跟随 DSH 压缩',
      modeManualNote: '每攒够设定轮数打成一个包。包更细，索引更密。',
      modeSyncNote: 'DSH 压缩发生时，把这次移出视野的对话打成包。',
      rounds: '每包轮数',
      roundsUnit: '轮',
      warn: '预警字数',
      warnUnit: '万字',
      actions: '操作',
      tutorial: '新手教程',
      defaults: '默认配置',
      askAi: '让 AI 决定',
      tutorialBody:
        '每轮对话会抄到 .dsh-memory/staging，攒够后打成 .dsh-memory/packs/pack-NNN，'
        + '并在 AGENTS.local.md 里留一个指针。不会往对话里写任何东西。',
      close: '关闭',
      saving: '保存中…',
      noSession: '还没有打开会话，暂时读不到设置。',
      unavailable: '当前环境无法执行命令。',
      loaded: '已读取。',
      askAiPending: '让 AI 决定这一项还没做：它需要先想清楚由哪一方读会话、按什么标准选值。',
    }

    const CSS = `
.dm-trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:32px;padding:0 8px;border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:13px;text-align:left}
.dm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f6)}
.dm-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2b6cff);outline-offset:-2px}
.dm-trigger-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dm-trigger-chev{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f9c)}
.dm-backdrop{position:fixed;inset:0;z-index:80;background:rgba(15,18,24,.38);display:flex;align-items:center;justify-content:center;padding:24px}
.dm-panel{box-sizing:border-box;width:460px;max-width:100%;max-height:82vh;overflow:auto;padding:16px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 18px 48px rgba(15,18,24,.22);display:flex;flex-direction:column;gap:12px}
.dm-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dm-title{margin:0;font-size:15px;font-weight:600}
.dm-x{border:none;background:transparent;font-size:18px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-secondary,#5b6070);padding:0 4px}
.dm-note{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#5b6070)}
.dm-card{padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f2f3f6);display:flex;flex-direction:column;gap:8px}
.dm-section{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#5b6070);font-weight:600}
.dm-choices{display:flex;flex-wrap:wrap;gap:8px}
.dm-choice{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#d7d9e0);background:transparent;font:inherit;font-size:13px;cursor:pointer;color:inherit}
.dm-choice[data-on=true]{background:var(--dsw-alias-brand-primary,#2b6cff);border-color:transparent;color:#fff}
.dm-slider{display:flex;align-items:center;gap:10px}
.dm-slider input{flex:1;accent-color:var(--dsw-alias-brand-primary,#2b6cff)}
.dm-read{min-width:4.6em;text-align:right;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:13px}
.dm-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.dm-btn{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#d7d9e0);background:transparent;font:inherit;font-size:13px;cursor:pointer;color:inherit}
.dm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f2f3f6)}
.dm-btn[data-kind=primary]{background:var(--dsw-alias-brand-primary,#2b6cff);border-color:transparent;color:#fff}
.dm-btn:disabled{opacity:.5;cursor:default}
.dm-msg{padding:7px 9px;border-radius:8px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2,#f2f3f6);color:var(--dsw-alias-label-secondary,#5b6070);white-space:pre-wrap}
.dm-msg[data-tone=err]{color:#c0392b}
`

    function apply(ctx) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-memory'
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'dsh-memory: styles')

      function pickRunner(list) {
        const ids = list?.ids ?? []
        for (const id of ids) {
          if ((list.byId?.[id]?.retainedBy?.mainView ?? 0) > 0) return id
        }
        return ids.length > 0 ? ids[0] : null
      }

      function useSessionList() {
        const store = ctx.uiWorkspace?.sessions?.list
        const subscribe = React.useCallback(
          (onChange) =>
            store !== undefined && typeof store.subscribe === 'function'
              ? store.subscribe(onChange)
              : () => {},
          [store],
        )
        const getSnapshot = React.useCallback(
          () =>
            store !== undefined && typeof store.getSnapshot === 'function'
              ? store.getSnapshot()
              : EMPTY_SESSIONS,
          [store],
        )
        return React.useSyncExternalStore(subscribe, getSnapshot)
      }

      /** Run one `/memory` sub-command and return the Host's reply text. */
      async function runMemory(runnerId, line) {
        if (runnerId === null || runnerId === undefined) throw new Error(T.noSession)
        const commands = ctx.remote?.commands
        if (commands === undefined || typeof commands.execute !== 'function') {
          throw new Error(T.unavailable)
        }
        const response = await commands.execute(runnerId, `/memory ${line}`, [])

        // The envelope is `{ok, value: {commandId, result: CommandResult}}`, and
        // only `result.text` holds what the command produced. Reading one level
        // too high yields the JSON of the envelope, which parses as no settings
        // at all — the panel then silently keeps its defaults.
        const envelope = response !== null && typeof response === 'object' ? response : {}
        if (envelope.ok === false) {
          throw new Error(
            `${envelope.error?.code ?? 'remote'}: ${envelope.error?.message ?? ''}`,
          )
        }

        const result = envelope.value?.result ?? envelope.result ?? envelope
        if (result !== null && typeof result === 'object' && result.kind === 'error') {
          throw new Error(String(result.text ?? 'command failed'))
        }
        if (typeof result?.text === 'string') return result.text
        if (typeof result === 'string') return result
        return JSON.stringify(result)
      }

      /**
       * Parse `/memory status` back into the three settings.
       *
       * The Host prints human-readable lines because that is what a user sees
       * when typing the command; reading those same lines keeps one
       * representation instead of two that can disagree.
       */
      function parseStatus(text) {
        const out = { mode: null, rounds: null, warn: null }
        for (const raw of String(text).split('\n')) {
          const m = /^(模式|每包轮数|预警字数)：(.+)$/.exec(raw.trim())
          if (m === null) continue
          if (m[1] === '模式') out.mode = m[2].trim()
          if (m[1] === '每包轮数') {
            const n = Number(m[2].trim())
            if (Number.isFinite(n)) out.rounds = n
          }
          if (m[1] === '预警字数') {
            const n = Number(m[2].trim())
            if (Number.isFinite(n)) out.warn = n
          }
        }
        return out
      }

      function MemoryBar() {
        const list = useSessionList()
        const runnerId = pickRunner(list)
        const [open, setOpen] = React.useState(false)
        // `last` is what `reset` restores on this side: the values the Host
        // reports after the form was last saved or loaded, so the sliders show
        // what is really in the patch file rather than the numbers this panel
        // happened to have touched.
        const [last, setLast] = React.useState({ mode: 'manual', rounds: 15, warn: 200000 })
        const [mode, setMode] = React.useState('manual')
        const [rounds, setRounds] = React.useState(15)
        const [warn, setWarn] = React.useState(200000)
        const [tutorial, setTutorial] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [message, setMessage] = React.useState(null)
        const [failed, setFailed] = React.useState(false)

        const say = (text, err = false) => {
          setMessage(text)
          setFailed(err)
        }

        const adopt = (parsed) => {
          const next = {
            mode: parsed.mode ?? last.mode,
            rounds: parsed.rounds ?? last.rounds,
            warn: parsed.warn ?? last.warn,
          }
          setLast(next)
          setMode(next.mode)
          setRounds(next.rounds)
          setWarn(next.warn)
        }

        const load = React.useCallback(async () => {
          setBusy(true)
          try {
            const text = await runMemory(runnerId, 'status')
            adopt(parseStatus(text))
            say(text)
          } catch (error) {
            say(error instanceof Error ? error.message : String(error), true)
          } finally {
            setBusy(false)
          }
        }, [runnerId])

        const send = React.useCallback(
          async (lines) => {
            setBusy(true)
            try {
              let reply = ''
              for (const line of lines) reply = await runMemory(runnerId, line)
              say(reply)
            } catch (error) {
              say(error instanceof Error ? error.message : String(error), true)
            } finally {
              setBusy(false)
            }
          },
          [runnerId],
        )

        const openPanel = () => {
          setOpen(true)
          void load()
        }

        const trigger = h(
          'button',
          { type: 'button', className: 'dm-trigger', onClick: openPanel, title: T.trigger },
          h('span', { className: 'dm-trigger-text' }, T.trigger),
          h('span', { className: 'dm-trigger-chev' }, '›'),
        )

        if (!open) return trigger

        const card = (key, section, children) =>
          h('div', { className: 'dm-card', key }, h('div', { className: 'dm-section' }, section), ...children)

        return h(
          React.Fragment,
          null,
          trigger,
          h(
            'div',
            {
              className: 'dm-backdrop',
              onClick: (event) => {
                if (event.target === event.currentTarget) setOpen(false)
              },
            },
            h(
              'div',
              { className: 'dm-panel', role: 'dialog', 'aria-modal': 'true' },
              h(
                'div',
                { className: 'dm-head' },
                h('h3', { className: 'dm-title' }, T.title),
                h('button', { type: 'button', className: 'dm-x', onClick: () => setOpen(false) }, '×'),
              ),
              h('p', { className: 'dm-note' }, T.hint),

              card('mode', T.mode, [
                h(
                  'div',
                  { className: 'dm-choices', key: 'c' },
                  h(
                    'button',
                    {
                      key: 'm',
                      type: 'button',
                      className: 'dm-choice',
                      'data-on': mode === 'manual',
                      onClick: () => setMode('manual'),
                    },
                    T.modeManual,
                  ),
                  h(
                    'button',
                    {
                      key: 's',
                      type: 'button',
                      className: 'dm-choice',
                      'data-on': mode === 'sync',
                      onClick: () => setMode('sync'),
                    },
                    T.modeSync,
                  ),
                ),
                h('p', { className: 'dm-note', key: 'n' }, mode === 'manual' ? T.modeManualNote : T.modeSyncNote),
              ]),

              card('rounds', T.rounds, [
                h(
                  'div',
                  { className: 'dm-slider', key: 'r' },
                  h('input', {
                    type: 'range',
                    min: 3,
                    max: 60,
                    value: rounds,
                    onChange: (event) => setRounds(Number(event.target.value)),
                  }),
                  h('span', { className: 'dm-read' }, `${rounds} ${T.roundsUnit}`),
                ),
              ]),

              card('warn', T.warn, [
                h(
                  'div',
                  { className: 'dm-slider', key: 'r' },
                  h('input', {
                    type: 'range',
                    min: 20000,
                    max: 800000,
                    step: 20000,
                    value: warn,
                    onChange: (event) => setWarn(Number(event.target.value)),
                  }),
                  h('span', { className: 'dm-read' }, `${Math.round(warn / 10000)} ${T.warnUnit}`),
                ),
              ]),

              card('actions', T.actions, [
                h(
                  'div',
                  { className: 'dm-actions', key: 'b', style: { justifyContent: 'flex-start' } },
                  h(
                    'button',
                    { key: 'tut', type: 'button', className: 'dm-btn', onClick: () => setTutorial(!tutorial) },
                    T.tutorial,
                  ),
                  h(
                    'button',
                    {
                      key: 'def',
                      type: 'button',
                      className: 'dm-btn',
                      disabled: busy,
                      onClick: () => {
                        void (async () => {
                          await send(['reset'])
                          // Read back what the Host now reports instead of
                          // assuming the defaults; the patch may carry keys this
                          // form does not touch.
                          await load()
                        })()
                      },
                    },
                    T.defaults,
                  ),
                  h(
                    'button',
                    {
                      key: 'ai',
                      type: 'button',
                      className: 'dm-btn',
                      onClick: () => say(T.askAiPending),
                    },
                    T.askAi,
                  ),
                ),
              ]),

              tutorial ? h('div', { className: 'dm-msg', key: 'tut' }, T.tutorialBody) : null,
              message
                ? h('div', { className: 'dm-msg', key: 'msg', 'data-tone': failed ? 'err' : undefined }, message)
                : null,

              h(
                'div',
                { className: 'dm-actions', key: 'foot' },
                h(
                  'button',
                  { type: 'button', className: 'dm-btn', disabled: busy, onClick: () => void load() },
                  '读取当前',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dm-btn',
                    'data-kind': 'primary',
                    disabled: busy,
                    onClick: () =>
                      void send([`mode ${mode}`, `rounds ${rounds}`, `warn ${warn}`]),
                  },
                  busy ? T.saving : '保存',
                ),
                h('button', { type: 'button', className: 'dm-btn', onClick: () => setOpen(false) }, T.close),
              ),
            ),
          ),
        )
      }

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-memory-bar', order: 64 },
          MemoryBar,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
