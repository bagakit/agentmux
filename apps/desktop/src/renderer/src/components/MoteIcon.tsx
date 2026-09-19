import type { SVGProps } from 'react'

/** A small, hand-shaped seed: one solid contour with a curved cut through its centre. */
export function MoteIcon({ size = 14, ...props }: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        fillRule="evenodd"
        d="M7.1 3.8c1.6-1.6 4.5-2 6.5-.9l5 2.8c1.6.9 2.5 2.7 2.1 4.6l-.9 5.2c-.3 1.6-1.4 2.9-2.9 3.5l-4.5 2c-1.9.9-3.8.4-5.1-1.1l-3.6-4.2c-1.1-1.3-1.3-3.1-.7-4.7l2.2-5.1c.4-.8 1.1-1.5 1.9-2.1Zm8.2 2.9c-4.4 1.4-6.7 4.8-5.2 7.9.7 1.4 2 2.3 3.7 2.7-1.5-1.9-2.2-3.4-1.6-5.2.5-1.9 2-3.7 3.1-5.4Z"
      />
    </svg>
  )
}
