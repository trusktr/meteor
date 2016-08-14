// import React from 'react'
// import ReactDOM from 'react-dom'
// import startup from 'awaitbox/meteor/startup'
//
// import './main.html';
//
// import App from './app/App'
//
// main()
// async function main() {
//     await startup()
//     const appRoot = document.querySelector('#app-root')
//     ReactDOM.render(<App msg="Mighty Devs!" />, appRoot)
// }

class A {
    static [Symbol.hasInstance] (instance) {
        console.log('custom instanceof check!', instance)
        return false
    }
}

console.log(A[Symbol.hasInstance]) // it is there!

class B extends A {}

class C extends B {}
class D extends B {}

console.log('should be false:', (new C) instanceof D)
console.log('should be true:', (new C) instanceof B)
console.log('should be false:', (new C) instanceof A) // outputs "true", and should also output "custom instanceof check!" but doesn't.
