class A {
    static [Symbol.hasInstance](obj) {
        if (this !== A) return super[Symbol.hasInstance](obj)
        return true
    }
}

console.log('What the?', Object.getOwnPropertySymbols(A))
