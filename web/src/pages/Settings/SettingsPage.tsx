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

/** 本地编辑草稿：apiKey 空字符串=保持原值，非空=覆盖 */
interface ProfileDraft {
  id: string
  name: string
  baseURL: string
  apiKey: string
  apiKeyMasked: string
  model: string
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
          c.profiles.map((p) => ({
            id: p.id,
            name: p.name,
            baseURL: p.baseURL,
            apiKey: '',
            apiKeyMasked: p.apiKey,
            model: p.model,
          })),
        )
      })
      .catch((e) => setError(e instanceof ApiRequestError ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  function newProfile() {
    setDrafts((ds) => [
      ...ds,
      {
        id: '', // 后端生成
        name: '新 profile',
        baseURL: 'https://api.deepseek.com',
        apiKey: '',
        apiKeyMasked: '',
        model: 'deepseek-v4-flash',
      },
    ])
  }

  function updateDraft(idx: number, patch: Partial<ProfileDraft>) {
    setDrafts((ds) => ds.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
  }

  function removeDraft(idx: number) {
    setDrafts((ds) => ds.filter((_, i) => i !== idx))
  }

  async function save() {
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
      const updated = await putConfig({ activeProfileId: activeId, profiles })
      setActiveId(updated.activeProfileId)
      setDrafts(
        updated.profiles.map((p) => ({
          id: p.id,
          name: p.name,
          baseURL: p.baseURL,
          apiKey: '',
          apiKeyMasked: p.apiKey,
          model: p.model,
        })),
      )
      setTestResult({})
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function test(idx: number) {
    const d = drafts[idx]
    if (!d.id) {
      setError('请先保存新 profile 再测试连接')
      return
    }
    setTestingIdx(idx)
    try {
      const r = await testProfile(d.id)
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
          <h3>LLM Provider</h3>
          <button onClick={newProfile} className={styles.addBtn}>
            + 新建
          </button>
        </div>
        <p className={styles.hint}>
          API Key 保存在后端 config.json（权限 0600），浏览器不暴露。激活的 profile 用于所有 LLM 调用。
        </p>

        {drafts.length === 0 && <p className={styles.empty}>未配置任何 provider，点击「新建」添加。</p>}

        {drafts.map((d, idx) => (
          <div key={d.id || `new-${idx}`} className={styles.profileCard}>
            <div className={styles.profileHead}>
              <input
                className={styles.nameInput}
                value={d.name}
                onChange={(e) => updateDraft(idx, { name: e.target.value })}
                placeholder="profile 名称"
              />
              <label className={styles.activeLabel}>
                <input
                  type="radio"
                  checked={activeId === d.id}
                  onChange={() => d.id && setActiveId(d.id)}
                  disabled={!d.id}
                />
                激活
              </label>
              <button onClick={() => removeDraft(idx)} className={styles.delBtn}>
                删除
              </button>
            </div>
            <label className={styles.field}>
              <span>baseURL</span>
              <input
                value={d.baseURL}
                onChange={(e) => updateDraft(idx, { baseURL: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span>model</span>
              <input value={d.model} onChange={(e) => updateDraft(idx, { model: e.target.value })} />
            </label>
            <label className={styles.field}>
              <span>
                apiKey
                {d.apiKeyMasked && <em>（当前：{d.apiKeyMasked}，留空保持）</em>}
              </span>
              <input
                type="password"
                value={d.apiKey}
                onChange={(e) => updateDraft(idx, { apiKey: e.target.value })}
                placeholder={d.apiKeyMasked || '输入 API Key'}
              />
            </label>
            <div className={styles.profileFoot}>
              <button
                onClick={() => test(idx)}
                disabled={testingIdx === idx}
                className={styles.testBtn}
              >
                {testingIdx === idx ? '测试中...' : '测试连接'}
              </button>
              {testResult[idx] && (
                <span className={testResult[idx].ok ? styles.ok : styles.fail}>
                  {testResult[idx].ok ? '✓ ' : '✗ '}
                  {testResult[idx].msg}
                </span>
              )}
            </div>
          </div>
        ))}

        <button onClick={save} disabled={saving} className={styles.saveBtn}>
          {saving ? '保存中...' : '保存配置'}
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
