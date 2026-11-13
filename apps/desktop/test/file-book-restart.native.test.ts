import { expect, it } from 'vitest'
import { runBookRestart } from './helpers/book-reader-restart/runner'
it('restores the original File and reading place through the real Store and both durable owners after an Electron restart', async()=>{
  const result=await runBookRestart()
  expect(result.writer.failure,result.writer.failure).toBeUndefined()
  expect(result.reader.failure,result.reader.failure).toBeUndefined()
  expect(result.reader.restored).toBe(true)
},300000)
