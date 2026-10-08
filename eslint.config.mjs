import neostandard from 'neostandard'

export default [
  { ignores: ['**/.type/'] },
  ...neostandard({ ts: true, noJsx: true }),
  {
    rules: {
      'no-undef': 'off' // taken care of by typescript
    }
  }
]
