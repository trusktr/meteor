// doesn't work
class A {
    static [Symbol.hasInstance](obj) {
        if (this !== A) return super[Symbol.hasInstance](obj)
        return true
    }
}

console.log('What the?', Object.getOwnPropertySymbols(A))

// works
class B {
}

Object.defineProperty(B, Symbol.hasInstance, {
    value: function (obj) {
        if (this !== B) return Object.getPrototypeOf(B)[Symbol.hasInstance].call(this, obj)
        return true
    }
})

console.log('What the?', Object.getOwnPropertySymbols(B))
