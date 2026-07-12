import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
}

interface CardHeaderProps {
  children: ReactNode;
  className?: string;
}

interface CardTitleProps {
  children: ReactNode;
  className?: string;
}

interface CardDescriptionProps {
  children: ReactNode;
  className?: string;
}

interface CardContentProps {
  children: ReactNode;
  className?: string;
}

function Card({ children, className = "" }: CardProps) {
  return (
    <div
      className={`rounded-2xl border border-neutral-200 bg-neutral-100 ${className}`}
    >
      {children}
    </div>
  );
}

function CardHeader({ children, className = "" }: CardHeaderProps) {
  return <div className={`px-6 py-4 ${className}`}>{children}</div>;
}

function CardTitle({ children, className = "" }: CardTitleProps) {
  return (
    <h2 className={`text-lg font-semibold text-neutral-900 ${className}`}>
      {children}
    </h2>
  );
}

function CardDescription({ children, className = "" }: CardDescriptionProps) {
  return (
    <p className={`mt-1 text-sm text-neutral-500 ${className}`}>{children}</p>
  );
}

function CardContent({ children, className = "" }: CardContentProps) {
  return <div className={`px-6 py-4 ${className}`}>{children}</div>;
}

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  type CardProps,
  type CardHeaderProps,
  type CardTitleProps,
  type CardDescriptionProps,
  type CardContentProps,
};
