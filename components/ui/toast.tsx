"use client";

import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";
import { useEffect } from "react";

export type ToastLevel = "OK" | "WARN" | "ERROR";

export interface Toast {
  id: string;
  level: ToastLevel;
  message: string;
  createdAt: number;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss(id: string): void }) {
  useEffect(() => {
    if (toast.level === "ERROR") return;
    const timer = setTimeout(() => onDismiss(toast.id), Math.max(0, 4200 - (Date.now() - toast.createdAt)));
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  const Icon = toast.level === "OK" ? CheckCircle2 : toast.level === "WARN" ? AlertTriangle : XCircle;

  return (
    <div className="toast" data-level={toast.level} onClick={() => onDismiss(toast.id)} role="alert">
      <span className="toast-icon" data-level={toast.level}>
        <Icon size={15} />
      </span>
      <span className="toast-msg">{toast.message}</span>
      <button
        aria-label="Dismiss"
        className="toast-dismiss"
        onClick={(e) => { e.stopPropagation(); onDismiss(toast.id); }}
        type="button"
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: string): void }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
