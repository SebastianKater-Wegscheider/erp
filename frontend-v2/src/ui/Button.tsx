import React from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "sm" | "icon";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
};

function cn(...parts: Array<string | false | undefined | null>) {
  return parts.filter(Boolean).join(" ");
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  asChild,
  children,
  ...props
}: ButtonProps) {
  const btnClassName = cn("btn", `btn--${variant}`, `btn--${size}`, className);

  if (asChild) {
    if (!React.isValidElement(children)) {
      throw new Error("Button with asChild expects a single React element child.");
    }
    const child = children as React.ReactElement<any>;
    const mergedClassName = cn(child.props?.className, btnClassName);
    return React.cloneElement(child, { ...props, className: mergedClassName });
  }

  return (
    <button className={btnClassName} {...props}>
      {children}
    </button>
  );
}
