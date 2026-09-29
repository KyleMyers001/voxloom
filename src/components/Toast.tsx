interface ToastProps {
  message: string;
}

export function Toast({ message }: ToastProps) {
  return (
    <div aria-live="polite" className={message ? 'toast visible' : 'toast'}>
      {message}
    </div>
  );
}
