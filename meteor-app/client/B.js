// --- Module B

import C from './C'

let B

export
function setUpB(C) {

    console.log('setUpB', C)

    B = class B extends C {
        // ...
    }

}

console.log('Module B', C, setUpB)

export {B as default}
