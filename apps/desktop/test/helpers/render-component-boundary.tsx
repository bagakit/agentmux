import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

export function renderComponentBoundary<Props>(Component: (props: Props) => ReactElement, props: Props): ReactElement {
  let result: ReactElement | undefined
  function Capture() { result = Component(props); return null }
  renderToStaticMarkup(createElement(Capture))
  if (!result) throw new Error('Component did not render its public boundary')
  return result
}
