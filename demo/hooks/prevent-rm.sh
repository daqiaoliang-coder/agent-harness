#!/usr/bin/env bash
# 对照: .claude/hooks/prevent-rm.sh — PreToolUse Hook 拦截 rm 的经典示例
# 决策协议: 优先 stdout JSON(permissionDecision); 也可退出码 2 表示刻意拒绝
input=$(cat)
if echo "$input" | grep -q '"command":"[^"]*rm '; then
  # 命中 rm 命令 → 输出 JSON deny 决策, 退出码 0(JSON 协议)
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"prevent-rm.sh: 禁止删除命令, 请改用安全方式"}}
EOF
  exit 0
fi
# 其他命令: 退出码 0 无 JSON → 放行
exit 0
