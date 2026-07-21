import { useEffect, useState } from 'react'
import { getConfig, putConfig, type LLMProfile } from '../../api/config'
import { testProfile } from '../../api/llm'
import { ApiRequestError } from '../../api/client'
import { refreshSkills, fetchSkills, type SkillRegistryError } from '../../api/skills'
import { SUBAGENT_REGISTRY, SKILLS_BY_SUBAGENT, loadUserSkills } from '../../skills/skillLoader'
import styles from './SettingsPage.module.css'

interface Props {
  onClose: () => void
}

type ProviderPreset = 'deepseek' | 'openai' | 'custom'

const PROVIDERS: Record<ProviderPreset, { label: string; baseURL: string; model: string }> = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com',
    model: 'gpt-4o-mini',
  },
  custom: {
    label: '其他品牌',
    baseURL: '',
    model: '',
  },
}

/** 本地编辑草稿：apiKey 空字符串=保持原值，非空=覆盖 */
interface ProfileDraft {
  id: string
  name: string
  provider: ProviderPreset
  baseURL: string
  apiKey: string
  apiKeyMasked: string
  model: string
}

function detectProvider(baseURL: string): ProviderPreset {
  if (baseURL.includes('api.deepseek.com')) return 'deepseek'
  if (baseURL.includes('api.openai.com')) return 'openai'
  return 'custom'
}

function createDraft(provider: ProviderPreset = 'deepseek'): ProfileDraft {
  const preset = PROVIDERS[provider]
  return {
    id: '',
    name: preset.label,
    provider,
    baseURL: preset.baseURL,
    apiKey: '',
    apiKeyMasked: '',
    model: preset.model,
  }
}

export function SettingsPage({ onClose }: Props) {
  const [drafts, setDrafts] = useState<ProfileDraft[]>([])
  const [activeId, setActiveId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingIdx, setTestingIdx] = useState<number | null>(null)
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean; msg: string }>>({})
  const [error, setError] = useState<string | null>(null)
  // v7.1 M5：Skill 库展示
  const [skillList, setSkillList] = useState<
    { subagentId: string; skillId: string; name: string; source: 'builtin' | 'user' }[]
  >([])
  const [skillErrors, setSkillErrors] = useState<SkillRegistryError[]>([])
  const [refreshing, setRefreshing] = useState(false)

  /** v7.1 M5：刷新 Skill 库——后端重扫 server/data/skills/ + 前端 overlay + 读当前 registry 展示 */
  async function reloadSkills() {
    setRefreshing(true)
    try {
      await refreshSkills()
      await loadUserSkills()
      const list: {
        subagentId: string
        skillId: string
        name: string
        source: 'builtin' | 'user'
      }[] = []
      for (const sa of SUBAGENT_REGISTRY) {
        const skills = SKILLS_BY_SUBAGENT.get(sa.id) ?? []
        for (const sk of skills) {
          list.push({
            subagentId: sa.id,
            skillId: sk.skillId,
            name: sk.name,
            source: sk.source ?? 'builtin',
          })
        }
      }
      setSkillList(list)
      const snap = await fetchSkills()
      setSkillErrors(snap.errors)
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void reloadSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    getConfig()
      .then((c) => {
        setActiveId(c.activeProfileId)
        setDrafts(
          c.profiles.length > 0
            ? c.profiles.map((p) => ({
                id: p.id,
                name: p.name,
                provider: detectProvider(p.baseURL),
                baseURL: p.baseURL,
                apiKey: '',
                apiKeyMasked: p.apiKey,
                model: p.model,
              }))
            : [createDraft()],
        )
      })
      .catch((e) => setError(e instanceof ApiRequestError ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  function newProfile() {
    setDrafts((ds) => [...ds, createDraft()])
  }

  function updateDraft(idx: number, patch: Partial<ProfileDraft>) {
    setDrafts((ds) => ds.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
  }

  function updateProvider(idx: number, provider: ProviderPreset) {
    const preset = PROVIDERS[provider]
    updateDraft(idx, {
      provider,
      name: preset.label,
      baseURL: preset.baseURL,
      model: preset.model,
    })
  }

  function removeDraft(idx: number) {
    setDrafts((ds) => ds.filter((_, i) => i !== idx))
  }

  async function save(options?: { activateIdx?: number; testAfterSave?: boolean }) {
    setSaving(true)
    setError(null)
    try {
      const profiles: Partial<LLMProfile>[] = drafts.map((d) => ({
        id: d.id || undefined,
        name: d.name,
        baseURL: d.baseURL,
        model: d.model,
        apiKey: d.apiKey === '' ? undefined : d.apiKey, // 空保持原值
      }))
      let updated = await putConfig({
        activeProfileId: options?.activateIdx !== undefined
          ? drafts[options.activateIdx]?.id || undefined
          : activeId,
        profiles,
      })
      const activated = options?.activateIdx !== undefined
        ? updated.profiles[options.activateIdx]
        : undefined
      if (activated && updated.activeProfileId !== activated.id) {
        updated = await putConfig({
          activeProfileId: activated.id,
          profiles: updated.profiles.map((p) => ({
            id: p.id,
            name: p.name,
            baseURL: p.baseURL,
            model: p.model,
          })),
        })
      }
      const nextDrafts = updated.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        provider: detectProvider(p.baseURL),
        baseURL: p.baseURL,
        apiKey: '',
        apiKeyMasked: p.apiKey,
        model: p.model,
      }))
      setActiveId(updated.activeProfileId)
      setDrafts(nextDrafts)
      setTestResult({})
      if (options?.testAfterSave && options.activateIdx !== undefined) {
        await testSavedProfile(options.activateIdx, updated.profiles[options.activateIdx]?.id)
      }
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function testSavedProfile(idx: number, profileId: string | undefined) {
    if (!profileId) {
      setError('保存失败，未生成可测试的配置')
      return
    }
    setTestingIdx(idx)
    try {
      const r = await testProfile(profileId)
      setTestResult((m) => ({
        ...m,
        [idx]: { ok: r.ok, msg: r.ok ? `${r.model} · ${r.latencyMs}ms` : r.error ?? '失败' },
      }))
    } catch (e) {
      setTestResult((m) => ({
        ...m,
        [idx]: { ok: false, msg: e instanceof ApiRequestError ? e.message : String(e) },
      }))
    } finally {
      setTestingIdx(null)
    }
  }

  async function saveAndTest(idx: number) {
    const d = drafts[idx]
    if (!d.baseURL.trim() || !d.model.trim()) {
      setError('请填写接口地址和模型名称')
      return
    }
    if (!d.apiKey.trim() && !d.apiKeyMasked) {
      setError('请填写 API Key')
      return
    }
    await save({ activateIdx: idx, testAfterSave: true })
  }

  if (loading) return <div className={styles.wrap}>加载配置...</div>

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <button onClick={onClose} className={styles.backBtn}>
          ← 返回
        </button>
        <h2>设置</h2>
      </header>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3>模型服务</h3>
          <button onClick={newProfile} className={styles.addBtn}>
            + 添加一组
          </button>
        </div>
        <p className={styles.hint}>
          选择常用服务后填入 API Key 即可；其他品牌只要兼容 OpenAI 接口，填入 URL 和模型名称也能使用。
        </p>

        {drafts.length === 0 && <p className={styles.empty}>还没有模型配置，点击「添加一组」开始。</p>}

        {drafts.map((d, idx) => (
          <div key={d.id || `new-${idx}`} className={styles.profileCard}>
            <div className={styles.profileHead}>
              <div>
                <strong>{d.id && activeId === d.id ? '当前使用' : '备用配置'}</strong>
                <p>{d.provider === 'custom' ? 'OpenAI 兼容接口' : PROVIDERS[d.provider].label}</p>
              </div>
              <button onClick={() => removeDraft(idx)} className={styles.delBtn}>
                删除
              </button>
            </div>
            <label className={styles.field}>
              <span>模型品牌</span>
              <select
                value={d.provider}
                onChange={(e) => updateProvider(idx, e.target.value as ProviderPreset)}
              >
                {Object.entries(PROVIDERS).map(([value, preset]) => (
                  <option key={value} value={value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>API Key {d.apiKeyMasked && <em>（当前：{d.apiKeyMasked}，留空保持）</em>}</span>
              <input
                type="password"
                value={d.apiKey}
                onChange={(e) => updateDraft(idx, { apiKey: e.target.value })}
                placeholder={d.apiKeyMasked || '输入 API Key'}
              />
            </label>
            {d.provider === 'custom' && (
              <label className={styles.field}>
                <span>接口地址</span>
                <input
                  value={d.baseURL}
                  onChange={(e) => updateDraft(idx, { baseURL: e.target.value, name: '其他品牌' })}
                  placeholder="https://api.example.com"
                />
              </label>
            )}
            <label className={styles.field}>
              <span>模型名称</span>
              <input value={d.model} onChange={(e) => updateDraft(idx, { model: e.target.value })} />
            </label>
            <div className={styles.profileFoot}>
              <button
                onClick={() => saveAndTest(idx)}
                disabled={saving || testingIdx === idx}
                className={styles.saveBtn}
              >
                {saving || testingIdx === idx ? '连接中...' : '保存并测试连接'}
              </button>
              {testResult[idx] && (
                <span className={testResult[idx].ok ? styles.ok : styles.fail}>
                  {testResult[idx].ok ? '已连接：' : '连接失败：'}
                  {testResult[idx].msg}
                </span>
              )}
            </div>
          </div>
        ))}

        <button onClick={() => save()} disabled={saving} className={styles.secondaryBtn}>
          {saving ? '保存中...' : '仅保存配置'}
        </button>
        {error && <p className={styles.error}>{error}</p>}
      </section>

      {/* v7.1 M5：Skill 库——展示内置+用户源 Skill，刷新触发后端重扫 + 前端 overlay */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3>Skill 库</h3>
          <button onClick={reloadSkills} disabled={refreshing} className={styles.addBtn}>
            {refreshing ? '刷新中...' : '↻ 刷新'}
          </button>
        </div>
        <p className={styles.hint}>
          内置 Skill 来自 web/src/skills/；用户自定义 Skill 放 server/data/skills/&lt;subagentId&gt;/&lt;skillId&gt;/SKILL.md，点刷新后 overlay 覆盖同 id 内置。
        </p>
        {skillErrors.length > 0 && (
          <div className={styles.error}>
            {skillErrors.length} 个文件扫描失败：
            {skillErrors.map((e, i) => (
              <div key={i}>
                {e.path}: {e.message}
              </div>
            ))}
          </div>
        )}
        <div className={styles.skillList}>
          {skillList.map((s, i) => (
            <div key={i} className={styles.skillRow}>
              <span className={styles.skillName}>{s.name}</span>
              <span className={styles.skillPath}>
                {s.subagentId}/{s.skillId}
              </span>
              <span
                className={`${styles.skillBadge} ${
                  s.source === 'user' ? styles.skillUser : styles.skillBuiltin
                }`}
              >
                {s.source === 'user' ? '用户' : '内置'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
