const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function Pine64Logo({
  className,
  size = 18,
  variant = "mark"
}: {
  className?: string;
  size?: number;
  variant?: "mark" | "logotype";
}) {
  const width = Math.round(size * 0.73);
  const mark = (
    <img
      alt={variant === "logotype" ? "" : "PINE64 pinecone logo"}
      aria-hidden={variant === "logotype" ? "true" : undefined}
      className={variant === "mark" ? className : undefined}
      height={size}
      src={`${BASE_PATH}/pine64-pinecone.svg`}
      width={width}
    />
  );

  if (variant === "logotype") {
    return (
      <span aria-label="PINE64" className={className}>
        {mark}
        <span>PINE64</span>
      </span>
    );
  }

  return mark;
}
