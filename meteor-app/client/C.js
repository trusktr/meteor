// --- Module C

import A, {setUpA} from './A'
import B, {setUpB} from './B'

let C = class C {
    constructor() {
        // this may run later, after all three modules are evaluated, or
        // possibly never.
        console.log(A)
        console.log(B)
    }
}

setUpA(C)
console.log('Module C', A)

setUpB(C)
console.log('Module C', B)

export {C as default}
