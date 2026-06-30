async function login() {
    const email = document.getElementById("email").value.trim().toLowerCase();
    const password = document.getElementById("password").value;
    const error = document.getElementById("error");
    error.innerHTML = "";
    if(email==="" || password===""){
        error.innerHTML="Please enter Email and Password";
        return;
    }
    const { data, error:loginError } = await sb.auth.signInWithPassword({
        email,
        password
    });
    if(loginError){
        error.innerHTML=loginError.message;
        return;
    }
    window.location.href="index.html";
}
async function checkLogin(){
    const {
        data:{session}
    }=await sb.auth.getSession();
    if(!session){
        window.location.href="login.html";
    }
}
async function logout(){
    await sb.auth.signOut();
    window.location.href="login.html";
}
