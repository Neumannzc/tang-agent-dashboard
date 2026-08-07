// NewSessionRow：sidebar 项目块顶部的持久"新会话"行（DESIGN.md §5.3）
// click → 高亮 + 跳 Composer 进入 draft 模式（发首条消息时才真正建会话）

function EditIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

interface NewSessionRowProps {
  workspaceName: string;
  active: boolean;
  onNew: () => void;
}

export function NewSessionRow(props: NewSessionRowProps) {
  const { workspaceName, active, onNew } = props;
  return (
    <button
      type="button"
      className={`new-session-row${active ? " active" : ""}`}
      onClick={onNew}
      aria-label={`新建会话 in ${workspaceName}`}
    >
      <EditIcon />
      <span className="new-session-label">新会话 · {workspaceName}</span>
    </button>
  );
}
