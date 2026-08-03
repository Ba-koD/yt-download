//! 실행 파일에 아이콘을 박아 넣는다. 탐색기·작업 표시줄에서 보이는 그림이다.
//!
//! 실패해도 빌드를 세우지 않는다. 아이콘 도구(rc.exe)가 없는 자리에서도 관리자는 만들어져야 한다.

fn main() {
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=../assets/icon.ico");
        let mut resource = winresource::WindowsResource::new();
        resource.set_icon("../assets/icon.ico");
        if let Err(err) = resource.compile() {
            println!("cargo:warning=아이콘을 실행 파일에 넣지 못했습니다: {err}");
        }
    }
}
