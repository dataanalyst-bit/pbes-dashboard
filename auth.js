// ===============================
// PBES Analytics Authentication
// ===============================

// Login Function
async function login() {

    const email = document.getElementById("email").value.trim().toLowerCase();
    const password = document.getElementById("password").value;

    const error = document.getElementById("error");
    error.innerHTML = "";

    if(email==="" || password===""){
        error.innerHTML="Please enter Email and Password";
        return;
    }

    const { data, error:loginError } = await supabase.auth.signInWithPassword({
        email,
        password
    });

    if(loginError){

        error.innerHTML=loginError.message;
        return;

    }

    window.location.href="index.html";

}



// Check Login

async function checkLogin(){

    const {

        data:{session}

    }=await supabase.auth.getSession();

    if(!session){

        window.location.href="login.html";

    }

}



// Logout

async function logout(){

    await supabase.auth.signOut();

    window.location.href="login.html";

}
