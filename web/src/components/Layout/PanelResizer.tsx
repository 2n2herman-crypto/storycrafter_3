import { useCallback, useRef, useState } from 'react'
import styles from './PanelResizer.module.css'

interface PanelResizerProps {
  onResize: (deltaX: number) => void
}

export function PanelResizer({ onResize }: PanelResizerProps) {
  const [isDragging, setIsDragging] = useState(false)
  const startXRef = useRef(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      startXRef.current = e.clientX
      setIsDragging(true)

      const handleMouseMove = (ev: MouseEvent) => {
        const deltaX = ev.clientX - startXRef.current
        startXRef.current = ev.clientX
        onResize(deltaX)
      }

      const handleMouseUp = () => {
        setIsDragging(false)
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [onResize],
  )

  return (
    <div
      className={`${styles.resizer} ${isDragging ? styles.resizerActive : ''}`}
      onMouseDown={handleMouseDown}
    />
  )
}
