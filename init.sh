#!/bin/bash
#
# provision vmss virtual machine
#

set -ex

sudo sed -i 's/1/0/' /etc/apt/apt.conf.d/20auto-upgrades || true
source /etc/os-release

function install_packages(){
    # install docker
    sudo apt-get -o DPkg::Lock::Timeout=600 update
    sudo apt-get -o DPkg::Lock::Timeout=600 install -y \
        apt-transport-https \
        ca-certificates \
        curl \
        gnupg-agent \
        software-properties-common || return

    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | apt-key add -

    add-apt-repository \
       "deb [arch=amd64] https://download.docker.com/linux/ubuntu \
       $(lsb_release -cs) \
       stable"

    sudo apt-get -o DPkg::Lock::Timeout=600 update
    sudo apt-get -o DPkg::Lock::Timeout=600 install -y docker-ce docker-ce-cli containerd.io || return

    # install qemu for multi-arch docker
    #sudo apt-get install -y qemu binfmt-support qemu-user-static

    # install utilities for image build
    sudo apt-get -o DPkg::Lock::Timeout=600 install -y make || return
    sudo apt-get -o DPkg::Lock::Timeout=600 install -y python3-pip || return
    python3 -m pip install --force-reinstall --upgrade jinja2==2.10 || return
    python3 -m pip install j2cli==0.3.10 markupsafe==2.0.1 || return
    # for team services agent
    sudo apt-get -o DPkg::Lock::Timeout=600 install -y python-is-python2
    # install python2 libvirt 5.10.0
    sudo apt-get -o DPkg::Lock::Timeout=600 install -y python2-dev python-pkg-resources libvirt-dev pkg-config || return
    curl https://bootstrap.pypa.io/pip/2.7/get-pip.py | python2
    pip2 install libvirt-python==5.10.0
    pip2 install docker==4.4.1

    # install packages for vs test
    python3 -m pip install pytest==4.6.2 attrs==19.1.0 exabgp==4.0.10 distro==1.5.0 docker==4.4.1 redis==3.3.4
    sudo apt-get -o DPkg::Lock::Timeout=600 install -y libhiredis0.14 || return

    # install packages for kvm test
    sudo apt-get -o DPkg::Lock::Timeout=600 install -y libvirt-clients \
        qemu \
        openvswitch-switch \
        net-tools \
        bridge-utils \
        util-linux \
        iproute2 \
        vlan \
        apt-transport-https \
        ca-certificates \
        curl \
        software-properties-common \
        python3-libvirt \
        libzmq3-dev \
        libzmq5 \
        libboost-serialization1.71.0 \
        uuid-dev || return
}

for ((i=0;i<10;i++));do
    install_packages && break
    sleep 30
done

# install br_netfilter kernel module
modprobe br_netfilter

# set sysctl bridge parameters for testbed
sysctl -w net.bridge.bridge-nf-call-arptables=0
sysctl -w net.bridge.bridge-nf-call-ip6tables=0
sysctl -w net.bridge.bridge-nf-call-iptables=0

# set sysctl RCVBUF default parameter for testbed
sysctl -w net.core.rmem_default=509430500

# enable traffic forward
/usr/sbin/iptables -A FORWARD -j ACCEPT

# enable nat
iptables -t nat -A POSTROUTING -s 10.250.0.0/24 -o eth0 -j MASQUERADE

# echo add tmp user so that AzDevOps user id will be 1002.
# this is needed as sonic-mgmt container has an user id 1001 already
useradd -M sonictmp

# echo creating tmp AzDevOps account
tmpuser=AzDevOps
useradd -m $tmpuser
usermod -a -G docker $tmpuser
usermod -a -G adm $tmpuser
usermod -a -G sudo $tmpuser
echo "$tmpuser ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/100-$tmpuser
chmod 440 /etc/sudoers.d/100-$tmpuser

sudo python3 -m pip install docker==6.1.0 requests==2.31.0
sudo apt-get -o DPkg::Lock::Timeout=600 install libyang0.16 libboost1.71-dev libboost-dev

# create two partition on the 1T data disk
# first partition for azure pipeline agent
# second partition for data
# find data disk, assume it is 1T
datadisk=$(lsblk -d  | grep -E '[[:space:]]1T[[:space:]]' | awk '{print $1}')
sgdisk -n 0:0:500G -t 0:8300 -c 0:agent /dev/$datadisk
sgdisk -n 0:0:0 -t 0:8300 -c 0:data /dev/$datadisk
mkfs.ext4 /dev/${datadisk}1
mkfs.ext4 /dev/${datadisk}2

mkdir /agent
mount /dev/${datadisk}1 /agent
mkdir /data
mount /dev/${datadisk}2 /data

# clone sonic-mgmt repo
pushd /data
git clone https://github.com/Azure/sonic-mgmt
chown -R $tmpuser.$tmpuser /data/sonic-mgmt
popd
