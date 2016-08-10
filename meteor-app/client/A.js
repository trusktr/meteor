// --- Module A

import C from './C'

let A

export
function setUpA(C) {

    console.log('setUpA')
    console.log(C)

    A = class A extends C {
        // ...
    }

}

console.log('Module A', C, setUpA)

export {A as default}
