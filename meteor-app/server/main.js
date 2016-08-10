import startup from 'awaitbox/meteor/startup'

~async function main() {
    await startup()
    console.log('Server started!')
    // server code here...
}()
