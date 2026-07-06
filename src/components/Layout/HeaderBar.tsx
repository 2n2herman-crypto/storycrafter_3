import styles from './HeaderBar.module.css'

interface HeaderBarProps {
  title?: string
}

export function HeaderBar({ title = 'StoryCrafter' }: HeaderBarProps) {
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.mark}>
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className={styles.logo}>
          {title}
          <span className={styles.version}>v5</span>
        </span>
      </div>
      <button className={styles.settingsBtn} title="设置（未来扩展）">
        设置
      </button>
    </header>
  )
}
