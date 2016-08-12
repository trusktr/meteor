// --- Module C

class C {
    constructor() {
        // this may run later, after all three modules are evaluated, or
        // possibly never.

        import A from './A'
        import B from './B'

        console.log(A)
        console.log(B)
    }
}

export {C as default}
